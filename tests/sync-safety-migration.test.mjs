import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const sql = await readFile(
  new URL("../drizzle/migrations/0059_sync_safety_guards.sql", import.meta.url),
  "utf8",
);
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const request = "33333333-3333-4333-8333-333333333333";
const scope = {
  acceptance: true,
  repo: "OMERTA-ROW/jackboy-dev-control",
  ref: "main",
  taskBudgetUsd: 1,
};

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE user_roles(user_id uuid, role text);
    CREATE FUNCTION public.has_role(_user uuid, _role text) RETURNS boolean LANGUAGE sql AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user AND role = _role) $$;
    CREATE TABLE automation_policy(id int PRIMARY KEY, tier int, paused boolean, max_files int,
      max_lines int, updated_by uuid, updated_at timestamptz);
    CREATE TABLE audit_logs(actor uuid, action text, detail jsonb, outcome text);
    CREATE TABLE action_requests(id uuid PRIMARY KEY, resources jsonb);
    CREATE TABLE code_spend_reservations(request_id uuid REFERENCES action_requests(id),
      reserved_usd numeric NOT NULL CHECK(reserved_usd > 0 AND reserved_usd <= 5));
  `);
  return db;
}

const db = await fixture();
await db.exec(sql);
after(() => db.close());
beforeEach(async () => {
  await db.exec(
    "TRUNCATE user_roles, automation_policy, audit_logs, code_spend_reservations, action_requests CASCADE",
  );
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [owner]);
  await db.query("INSERT INTO user_roles VALUES ($1,'owner'),($2,'member')", [owner, other]);
  await db.exec(
    "INSERT INTO automation_policy(id,tier,paused,max_files,max_lines) VALUES(1,0,false,3,50)",
  );
  await db.query("INSERT INTO action_requests VALUES ($1,$2)", [request, JSON.stringify(scope)]);
});
const limits = () => db.exec("SELECT set_guardian_limits(1,4,60)");
const hold = (amount) =>
  db.query("INSERT INTO code_spend_reservations VALUES($1,$2)", [request, amount]);

test("Guardian limit-only updates preserve the latest Stop state and audit atomically", async () => {
  for (const paused of [true, false]) {
    await db.query("UPDATE automation_policy SET paused=$1", [paused]);
    await limits();
    const policy = (await db.query("SELECT paused,tier,max_files,max_lines FROM automation_policy"))
      .rows[0];
    assert.deepEqual(policy, { paused, tier: 1, max_files: 4, max_lines: 60 });
    const audit = (await db.query("SELECT detail FROM audit_logs")).rows.at(-1);
    assert.equal(audit.detail.paused, paused);
  }
});

test("non-owners, anonymous callers and invalid limits cannot change Guardian policy", async () => {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [other]);
  await assert.rejects(limits(), /Only the owner/);
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [owner]);
  await assert.rejects(db.exec("SELECT set_guardian_limits(3,4,60)"), /Invalid/);
  await assert.rejects(db.exec("SELECT set_guardian_limits(1,NULL,60)"), /Invalid/);
  await db.exec("SET ROLE anon");
  await assert.rejects(limits(), /permission denied/);
  await db.exec("RESET ROLE");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n, 0);
});

test("Guardian audit failure rolls back the limits and preserves Stop", async () => {
  await db.exec(`
    UPDATE automation_policy SET paused=true;
    CREATE FUNCTION reject_guardian_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'fixture audit unavailable'; END $$;
    CREATE TRIGGER reject_guardian_audit BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_guardian_audit();
  `);
  try {
    await assert.rejects(limits(), /fixture audit unavailable/);
    assert.deepEqual(
      (await db.query("SELECT paused,tier,max_files,max_lines FROM automation_policy")).rows[0],
      { paused: true, tier: 0, max_files: 3, max_lines: 50 },
    );
  } finally {
    await db.exec(
      "DROP TRIGGER reject_guardian_audit ON audit_logs; DROP FUNCTION reject_guardian_audit()",
    );
  }
});

test("actual acceptance holds are bound to the exact repo, main, reviewed lane and approved <=$1", async () => {
  await hold(1);
  await db.exec("TRUNCATE code_spend_reservations");
  for (const [patch, amount] of [
    [{}, 1.01],
    [{ repo: "owner/other" }, 1],
    [{ ref: "next" }, 1],
    [{ lane: "auto" }, 1],
    [{ taskBudgetUsd: null }, 1],
    [{ taskBudgetUsd: "1" }, 1],
    [{ taskBudgetUsd: 2 }, 2],
    [{ taskBudgetUsd: 0.5 }, 1],
  ]) {
    await db.query("UPDATE action_requests SET resources=$1", [
      JSON.stringify({ ...scope, ...patch }),
    ]);
    await assert.rejects(hold(amount), /Acceptance/);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM code_spend_reservations")).rows[0].n,
      0,
    );
  }
  await db.query("UPDATE action_requests SET resources=$1", [
    JSON.stringify({ ...scope, acceptance: false }),
  ]);
  await hold(2);
});

test("guard readiness is service-only and fails closed if its trigger is disabled", async () => {
  assert.equal(
    (await db.query("SELECT code_acceptance_guard_status() AS ready")).rows[0].ready,
    true,
  );
  await db.exec(
    "ALTER TABLE code_spend_reservations DISABLE TRIGGER code_acceptance_reservation_guard",
  );
  try {
    assert.equal(
      (await db.query("SELECT code_acceptance_guard_status() AS ready")).rows[0].ready,
      false,
    );
  } finally {
    await db.exec(
      "ALTER TABLE code_spend_reservations ENABLE TRIGGER code_acceptance_reservation_guard",
    );
  }
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.exec("SELECT code_acceptance_guard_status()"), /permission denied/);
  await db.exec("RESET ROLE");
  await db.exec("SET ROLE service_role");
  assert.equal(
    (await db.query("SELECT code_acceptance_guard_status() AS ready")).rows[0].ready,
    true,
  );
  await db.exec("RESET ROLE");
});

test("the migration is transactional on explicit rollback and installation failure", async () => {
  const isolated = await fixture();
  try {
    await isolated.exec(`BEGIN; ${sql}; ROLLBACK;`);
    assert.equal(
      (
        await isolated.query(
          "SELECT to_regprocedure('set_guardian_limits(integer,integer,integer)') AS f",
        )
      ).rows[0].f,
      null,
    );
    await isolated.exec("DROP TABLE code_spend_reservations");
    await assert.rejects(isolated.exec(`BEGIN; ${sql}; COMMIT;`));
    await isolated.exec("ROLLBACK");
    assert.equal(
      (
        await isolated.query(
          "SELECT to_regprocedure('set_guardian_limits(integer,integer,integer)') AS f",
        )
      ).rows[0].f,
      null,
    );
  } finally {
    await isolated.close();
  }
});

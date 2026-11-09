import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  skipNoPg,
  openDb,
  supabaseStubs,
  replay,
  setActivatedControls,
  closeAdmin,
} from "./helpers/staging-pg.mjs";

after(closeAdmin);
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const repo = "OMERTA-ROW/jackboy-dev-control";
const sha = "a".repeat(40);
const migration = () =>
  readFile("drizzle/migrations/0060_code_acceptance_guard_verification.sql", "utf8");
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0];
const ready = async (db) =>
  (await one(db, "SELECT public.code_acceptance_guard_status() AS ok")).ok;

test("0060 preserves the previous admission body except the additional fail-closed check", async () => {
  const previous = await readFile("drizzle/migrations/0046_code_total_spend_guard.sql", "utf8");
  const body = (sql) =>
    sql.match(
      /CREATE OR REPLACE FUNCTION public.claim_code_runtime_slot\([\s\S]*?END;\n\$\$;/,
    )?.[0];
  assert.ok(body(previous));
  assert.equal(
    body(await migration()),
    body(previous).replace(
      "    OR NOT public.code_total_spend_guard_enforced()",
      "    OR NOT public.code_total_spend_guard_enforced()\n" +
        "    OR (request_row.resources->>'acceptance' = 'true'\n" +
        "      AND public.code_acceptance_guard_status() IS DISTINCT FROM true)",
    ),
  );
});

async function fixture(through = "9999") {
  const db = await openDb();
  try {
    await db.exec(supabaseStubs);
    await replay(db, { through });
    await db.query("INSERT INTO auth.users(id) VALUES ($1),($2)", [owner, other]);
    await db.query(
      "INSERT INTO public.user_roles(user_id,role) VALUES ($1,'owner'),($2,'member')",
      [owner, other],
    );
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.query("UPDATE public.code_runtime_controls SET allowed_targets=$1::jsonb", [
      JSON.stringify({ [repo]: { ref: "main", workflowSha: sha } }),
    ]);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

let runId = 1000;
async function request(db, patch = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO public.action_requests
      (id,action,tier,nonce_hash,expires_at,requested_by,status,
       runner_claimed_at,runner_run_id,runner_run_attempt,resources)
     VALUES ($1,'code','high','fixture',now()+interval '1 hour',$2,'allowed',now(),$4,1,$3)`,
    [
      id,
      owner,
      JSON.stringify({
        repo,
        ref: "main",
        workflowSha: sha,
        acceptance: true,
        taskBudgetUsd: 1,
        ...patch,
      }),
      ++runId,
    ],
  );
  return id;
}
const hold = (db, id, amount = 1) =>
  db.query(
    `INSERT INTO public.code_spend_reservations(request_id,run_id,reserved_usd)
     SELECT id,runner_run_id,$2 FROM public.action_requests WHERE id=$1`,
    [id, amount],
  );
const claim = async (db, id) =>
  (
    await one(
      db,
      `SELECT public.claim_code_runtime_slot(id,$2,'main',$3,runner_run_id) AS ok
     FROM public.action_requests WHERE id=$1`,
      [id, repo, sha],
    )
  ).ok;
async function syntheticRuntime(db) {
  await db.query(
    "SELECT public.set_code_provider_hard_cap_verified($1,true,'Synthetic isolated fixture')",
    [owner],
  );
  await db.exec("SELECT public.refresh_code_spend_meter()");
  await setActivatedControls(
    db,
    "UPDATE public.code_runtime_controls SET enabled=true,kill_switch=false",
  );
}

test(
  "full-chain Guardian save uses real enum roles, preserves Stop and rolls back on audit failure",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      await db.exec("UPDATE public.automation_policy SET paused=true");
      await db.exec(
        "SET ROLE authenticated; SELECT public.set_guardian_limits(1,4,60); RESET ROLE",
      );
      assert.deepEqual(
        await one(db, "SELECT paused,tier,max_files,max_lines FROM public.automation_policy"),
        { paused: true, tier: 1, max_files: 4, max_lines: 60 },
      );
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [other]);
      await assert.rejects(db.exec("SELECT public.set_guardian_limits(2,5,70)"), /Only the owner/);
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
      await db.exec(`CREATE FUNCTION public.reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'fixture audit unavailable'; END $$;
      CREATE TRIGGER reject_test_audit BEFORE INSERT ON public.audit_logs
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_audit()`);
      await assert.rejects(
        db.exec("SELECT public.set_guardian_limits(2,5,70)"),
        /fixture audit unavailable/,
      );
      assert.deepEqual(
        await one(db, "SELECT paused,tier,max_files,max_lines FROM public.automation_policy"),
        { paused: true, tier: 1, max_files: 4, max_lines: 60 },
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "readiness rejects wrong event, timing, level, conditional and disabled acceptance triggers",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      assert.equal(await ready(db), true);
      for (const definition of [
        "BEFORE UPDATE ON public.code_spend_reservations FOR EACH ROW",
        "AFTER INSERT ON public.code_spend_reservations FOR EACH ROW",
        "BEFORE INSERT ON public.code_spend_reservations FOR EACH STATEMENT",
        "BEFORE INSERT ON public.code_spend_reservations FOR EACH ROW WHEN (false)",
      ]) {
        await db.exec(`DROP TRIGGER code_acceptance_reservation_guard ON public.code_spend_reservations;
        CREATE TRIGGER code_acceptance_reservation_guard ${definition}
        EXECUTE FUNCTION public.guard_code_acceptance_reservation()`);
        assert.equal(await ready(db), false, definition);
      }
      await db.exec(`DROP TRIGGER code_acceptance_reservation_guard ON public.code_spend_reservations;
      CREATE TRIGGER code_acceptance_reservation_guard BEFORE INSERT ON public.code_spend_reservations
      FOR EACH ROW EXECUTE FUNCTION public.guard_code_acceptance_reservation();
      ALTER TABLE public.code_spend_reservations DISABLE TRIGGER code_acceptance_reservation_guard`);
      assert.equal(await ready(db), false);
      await db.exec(
        "DROP TRIGGER code_acceptance_reservation_guard ON public.code_spend_reservations",
      );
      assert.equal(await ready(db), false);
    } finally {
      await db.close();
    }
  },
);

test(
  "acceptance claim refuses a missing or disabled guard with no hold or active slot",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      await syntheticRuntime(db);
      const id = await request(db);
      await db.exec(
        "ALTER TABLE public.code_spend_reservations DISABLE TRIGGER code_acceptance_reservation_guard",
      );
      assert.equal(await claim(db, id), false);
      await db.exec(
        "DROP TRIGGER code_acceptance_reservation_guard ON public.code_spend_reservations",
      );
      assert.equal(await claim(db, id), false);
      assert.deepEqual(
        await one(
          db,
          `SELECT active_request_id,
      (SELECT count(*)::int FROM public.code_spend_reservations) AS holds,
      (SELECT count(*)::int FROM public.audit_logs WHERE action='code.task_blocked') AS refusals
      FROM public.code_runtime_controls`,
        ),
        { active_request_id: null, holds: 0, refusals: 2 },
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "full-chain actual acceptance holds enforce owner scope and approved $1 maximum",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
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
        await assert.rejects(hold(db, await request(db, patch), amount), /Acceptance/);
      }
      assert.equal(
        (await one(db, "SELECT count(*)::int AS n FROM public.code_spend_reservations")).n,
        0,
      );
      await hold(db, await request(db));
    } finally {
      await db.close();
    }
  },
);

test(
  "current chain admits exactly $5 daily and refuses the next $1 without starting work",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      await syntheticRuntime(db);
      for (let n = 0; n < 6; n++) {
        const id = await request(db);
        assert.equal(await claim(db, id), n < 5);
        if (n < 5)
          await db.query(
            `SELECT public.finish_code_runtime_slot(id,runner_run_id,1,'success')
            FROM public.action_requests WHERE id=$1`,
            [id],
          );
      }
      assert.equal(
        Number(
          (await one(db, "SELECT sum(reserved_usd) AS usd FROM public.code_spend_reservations"))
            .usd,
        ),
        5,
      );
      assert.equal(
        (
          await one(
            db,
            `SELECT count(*)::int AS n FROM public.audit_logs
        WHERE action='code.task_blocked'`,
          )
        ).n,
        1,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "current chain admits exactly $10 cumulative including prior-day costs and refuses the next hold",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      await db.exec(`INSERT INTO public.code_usage_events(provider_event_id,source,occurred_at,cost_usd)
      VALUES ('fixture-old','openai_org_costs',now()-interval '3 days',8)`);
      await syntheticRuntime(db);
      for (let n = 0; n < 3; n++) {
        const id = await request(db);
        assert.equal(await claim(db, id), n < 2);
        if (n < 2)
          await db.query(
            `SELECT public.finish_code_runtime_slot(id,runner_run_id,1,'success')
            FROM public.action_requests WHERE id=$1`,
            [id],
          );
      }
      assert.equal(
        Number((await one(db, "SELECT public.code_total_spend_committed() AS usd")).usd),
        10,
      );
      await assert.rejects(hold(db, await request(db)), /cumulative spending limit/);
    } finally {
      await db.close();
    }
  },
);

test(
  "missing hard-cap, meter or cumulative guard evidence blocks admission",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const id = await request(db);
      assert.equal(await claim(db, id), false, "default stopped configuration");
      await syntheticRuntime(db);
      await db.exec("UPDATE public.code_runtime_controls SET provider_hard_cap_verified=false");
      assert.equal(await claim(db, id), false, "hard cap unverified");
      await db.exec("UPDATE public.code_runtime_controls SET enabled=false,kill_switch=true");
      await db.query(
        "SELECT public.set_code_provider_hard_cap_verified($1,true,'Synthetic fixture')",
        [owner],
      );
      await setActivatedControls(
        db,
        "UPDATE public.code_runtime_controls SET enabled=true,kill_switch=false",
      );
      await db.exec("UPDATE public.code_runtime_controls SET provider_usage_at=NULL");
      assert.equal(await claim(db, id), false, "meter missing");
      await db.exec("SELECT public.refresh_code_spend_meter()");
      await db.exec(
        "ALTER TABLE public.code_usage_events DISABLE TRIGGER code_usage_events_total_guard",
      );
      assert.equal(await claim(db, id), false, "cumulative enforcement missing");
      assert.equal(
        (await one(db, "SELECT count(*)::int AS n FROM public.code_spend_reservations")).n,
        0,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "parallel full-chain claims cannot oversubscribe daily or cumulative headroom",
  { skip: skipNoPg },
  async () => {
    for (const [priorCost, capacity] of [
      [0, 5],
      [8, 2],
    ]) {
      const db = await fixture();
      try {
        if (priorCost)
          await db.query(
            `INSERT INTO public.code_usage_events
          (provider_event_id,source,occurred_at,cost_usd)
          VALUES ('fixture-old','openai_org_costs',now()-interval '3 days',$1)`,
            [priorCost],
          );
        await syntheticRuntime(db);
        const ids = [];
        for (let n = 0; n < 16; n++) ids.push(await request(db));
        const finish = (id) =>
          db.query(
            `SELECT public.finish_code_runtime_slot(id,runner_run_id,1,'success')
          FROM public.action_requests WHERE id=$1`,
            [id],
          );
        const admitted = new Set();
        await Promise.all(
          ids.map(async (id) => {
            if (await claim(db, id)) {
              admitted.add(id);
              await finish(id);
            }
          }),
        );
        for (const id of ids) {
          if (!admitted.has(id) && (await claim(db, id))) {
            admitted.add(id);
            await finish(id);
          }
        }
        assert.equal(admitted.size, capacity);
        assert.equal(
          Number(
            (await one(db, "SELECT sum(reserved_usd) AS usd FROM public.code_spend_reservations"))
              .usd,
          ),
          capacity,
        );
        assert.equal(
          Number((await one(db, "SELECT public.code_total_spend_committed() AS usd")).usd),
          priorCost + capacity,
        );
      } finally {
        await db.close();
      }
    }
  },
);

test(
  "new migration installs and rolls back transactionally, and refuses live or incomplete schemas",
  { skip: skipNoPg },
  async () => {
    const db = await fixture("0059");
    try {
      const sql = await migration();
      const definition = async () =>
        (
          await one(
            db,
            `SELECT pg_get_functiondef(
      'public.code_acceptance_guard_status()'::regprocedure) AS d`,
          )
        ).d;
      const before = await definition();
      await db.exec(`BEGIN; ${sql}; ROLLBACK;`);
      assert.equal(await definition(), before);
      await syntheticRuntime(db);
      await assert.rejects(db.exec(`BEGIN; ${sql}; COMMIT;`), /disabled and stopped/);
      await db.exec("ROLLBACK");
      assert.equal(await definition(), before);
      await db.exec("UPDATE public.code_runtime_controls SET enabled=false,kill_switch=true");
      await hold(db, await request(db));
      await assert.rejects(db.exec(`BEGIN; ${sql}; COMMIT;`), /no active task or reservation/);
      await db.exec("ROLLBACK");
      assert.equal(await definition(), before);
    } finally {
      await db.close();
    }
    const incomplete = await fixture("0059");
    try {
      const sql = await migration();
      await incomplete.exec("DROP FUNCTION public.code_acceptance_guard_status()");
      await assert.rejects(incomplete.exec(`BEGIN; ${sql}; COMMIT;`), /Apply 0059/);
      await incomplete.exec("ROLLBACK");
    } finally {
      await incomplete.close();
    }
  },
);

test(
  "a late installation failure rolls back the replaced readiness function",
  { skip: skipNoPg },
  async () => {
    const db = await fixture("0059");
    try {
      const before = (
        await one(
          db,
          `SELECT pg_get_functiondef('public.code_acceptance_guard_status()'::regprocedure) AS d`,
        )
      ).d;
      await db.exec(`DROP FUNCTION public.claim_code_runtime_slot(uuid,text,text,text,bigint);
        CREATE FUNCTION public.claim_code_runtime_slot(uuid,text,text,text,bigint)
        RETURNS text LANGUAGE sql AS $$ SELECT 'incompatible restored signature'::text $$`);
      await assert.rejects(
        db.exec(`BEGIN; ${await migration()}; COMMIT;`),
        /cannot change return type/,
      );
      await db.exec("ROLLBACK");
      assert.equal(
        (
          await one(
            db,
            `SELECT pg_get_functiondef('public.code_acceptance_guard_status()'::regprocedure) AS d`,
          )
        ).d,
        before,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "guard and claim RPCs remain service-only and migration never enables CODE",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      for (const signature of [
        "public.code_acceptance_guard_status()",
        "public.claim_code_runtime_slot(uuid,text,text,text,bigint)",
      ]) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          assert.equal(
            (
              await one(db, "SELECT has_function_privilege($1,$2,'EXECUTE') AS ok", [
                role,
                signature,
              ])
            ).ok,
            role === "service_role",
            `${role}: ${signature}`,
          );
        }
      }
      assert.deepEqual(
        await one(db, "SELECT enabled,kill_switch FROM public.code_runtime_controls"),
        { enabled: false, kill_switch: true },
      );
      await db.exec("SET ROLE service_role");
      assert.equal(await ready(db), true);
      await db.exec("RESET ROLE");
    } finally {
      await db.close();
    }
  },
);

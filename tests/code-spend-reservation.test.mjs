import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "node:module";

// Isolated in-memory PGlite databases with synthetic data only. Nothing here reaches a provider,
// GitHub, or any real database. Tests that exercise the admission path drop the 0037 hard-cap CHECK
// in the throwaway database ONLY, because the real schema (correctly) can never admit a task yet.

// By default every test runs on an in-memory PGlite. When STAGING_PG_URL points at a LOOPBACK
// disposable PostgreSQL server (no production credentials), the same tests run on real PostgreSQL
// through a connection pool, one throwaway database per test. Non-loopback hosts are refused.
const stagingUrl = process.env.STAGING_PG_URL;
let pgPool;
async function openDb() {
  if (!stagingUrl) return new PGlite();
  const url = new URL(stagingUrl);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("STAGING_PG_URL must be a loopback host; refusing to connect");
  }
  const pg = createRequire(process.env.STAGING_PG_MODULE_FROM ?? import.meta.url)("pg");
  const admin = (pgPool ??= new pg.Pool({ connectionString: stagingUrl, max: 2 }));
  const name = `spend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 12 });
  return {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    close: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    },
  };
}
process.on("exit", () => pgPool?.end());

const ownerId = "00000000-0000-4000-8000-000000000001";
const nonOwnerId = "00000000-0000-4000-8000-000000000009";
const workflowSha = "a".repeat(40);
const repo = "owner/repo";
const rid = (n) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;
const secondsIntoUtcDay = () => {
  const now = new Date();
  return now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
};

async function baseDatabase() {
  const db = await openDb();
  await db.exec(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE public.action_requests (
      id uuid PRIMARY KEY,
      requested_by uuid NOT NULL,
      status text NOT NULL,
      runner_claimed_at timestamptz,
      runner_run_id bigint,
      runner_run_attempt integer,
      resources jsonb NOT NULL DEFAULT '{}'::jsonb,
      outcome text
    );
    CREATE TABLE public.omni_connection (config_hash text);
    CREATE TABLE public.audit_logs (
      actor uuid,
      action text NOT NULL,
      detail jsonb NOT NULL,
      outcome text NOT NULL
    );
    CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
  `);
  for (const file of [
    "0036_code_runner_claims",
    "0037_code_safety_controls",
    "0038_code_provider_costs",
  ]) {
    await db.exec(await readFile(`drizzle/migrations/${file}.sql`, "utf8"));
  }
  await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [ownerId]);
  return db;
}

const up = async (db) =>
  db.exec(await readFile("drizzle/migrations/0040_code_spend_reservations.sql", "utf8"));

// Test-only: lets the admission path run in a throwaway database.
async function admissionDatabase({ gateOpen = true } = {}) {
  const db = await baseDatabase();
  await up(db);
  if (gateOpen) {
    await db.exec(
      "ALTER TABLE public.code_runtime_controls DROP CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check",
    );
  }
  await db.query(
    `UPDATE public.code_runtime_controls
     SET enabled = true, kill_switch = false, provider_hard_cap_verified = $2,
         provider_usage_at = now(), allowed_targets = $1::jsonb
     WHERE singleton = true`,
    [JSON.stringify({ [repo]: { ref: "main", workflowSha } }), gateOpen],
  );
  return db;
}

async function seedRequest(db, n) {
  await db.query(
    `INSERT INTO public.action_requests
      (id, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt, resources)
     VALUES ($1, $2, 'allowed', now(), $3, 1, $4::jsonb)`,
    [rid(n), ownerId, 1000 + n, JSON.stringify({ repo, ref: "main", workflowSha })],
  );
}

async function claim(db, n) {
  await seedRequest(db, n).catch(() => {});
  const { rows } = await db.query(
    "SELECT public.claim_code_runtime_slot($1, $2, 'main', $3, $4) AS claimed",
    [rid(n), repo, workflowSha, 1000 + n],
  );
  return rows[0].claimed;
}

const finish = (db, n, outcome = "success") =>
  db.query("SELECT public.finish_code_runtime_slot($1, $2, 1, $3)", [rid(n), 1000 + n, outcome]);

const reservations = async (db) =>
  (
    await db.query(
      "SELECT request_id, status, outcome, reserved_usd::float AS reserved, released_usd::float AS released FROM public.code_spend_reservations ORDER BY created_at, request_id",
    )
  ).rows;

const addReportedSpend = (db, usd) =>
  db.query(
    `INSERT INTO public.code_usage_events(provider_event_id, source, occurred_at, cost_usd)
     VALUES ($1, 'openai_org_costs', date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', $2)`,
    [`spend-${Math.random()}`, usd],
  );

test("hard-cap invariant is untouched and claims still fail closed on the real schema", async () => {
  const db = await baseDatabase();
  try {
    await up(db);
    await assert.rejects(
      db.query(
        "UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true WHERE singleton = true",
      ),
      /check constraint/i,
    );
    await db.query(
      `UPDATE public.code_runtime_controls
       SET enabled = true, kill_switch = false, provider_usage_at = now(), allowed_targets = $1::jsonb`,
      [JSON.stringify({ [repo]: { ref: "main", workflowSha } })],
    );
    assert.equal(await claim(db, 1), false);
    assert.deepEqual(await reservations(db), []);
    const control = await db.query(
      "SELECT active_request_id FROM public.code_runtime_controls WHERE singleton = true",
    );
    assert.equal(control.rows[0].active_request_id, null);
    const audit = await db.query(
      "SELECT count(*)::integer AS n FROM public.audit_logs WHERE action = 'code.task_blocked'",
    );
    assert.equal(audit.rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test("reservation defaults and bounds are enforced by the database", async () => {
  const db = await baseDatabase();
  try {
    await up(db);
    const { rows } = await db.query(
      "SELECT per_task_reserve_usd::float AS reserve, reconcile_grace_seconds FROM public.code_runtime_controls",
    );
    assert.deepEqual(rows[0], { reserve: 1, reconcile_grace_seconds: 900 });
    for (const sql of [
      "UPDATE public.code_runtime_controls SET per_task_reserve_usd = 0",
      "UPDATE public.code_runtime_controls SET per_task_reserve_usd = 5.01",
      "UPDATE public.code_runtime_controls SET reconcile_grace_seconds = 299",
    ]) {
      await assert.rejects(db.query(sql), /check constraint/i);
    }
    const grants = await db.query(
      `SELECT has_function_privilege('anon', 'public.reconcile_code_spend_reservations(uuid)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.claim_code_runtime_slot(uuid,text,text,text,bigint)', 'EXECUTE') AS auth,
              has_function_privilege('service_role', 'public.reconcile_code_spend_reservations(uuid)', 'EXECUTE') AS service,
              has_table_privilege('authenticated', 'public.code_spend_reservations', 'SELECT') AS table_auth`,
    );
    assert.deepEqual(grants.rows[0], {
      anon: false,
      auth: false,
      service: true,
      table_auth: false,
    });
  } finally {
    await db.close();
  }
});

test("concurrent claims create exactly one reservation and a loser leaves no hold", async () => {
  const db = await admissionDatabase();
  try {
    for (const n of [1, 2, 3]) await seedRequest(db, n);
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        db.query("SELECT public.claim_code_runtime_slot($1, $2, 'main', $3, $4) AS claimed", [
          rid(n),
          repo,
          workflowSha,
          1000 + n,
        ]),
      ),
    );
    assert.equal(results.filter((r) => r.rows[0].claimed).length, 1);
    const held = await reservations(db);
    assert.equal(held.length, 1);
    assert.equal(held[0].status, "reserved");
    assert.equal(held[0].reserved, 1);
  } finally {
    await db.close();
  }
});

test("unreconciled holds cumulatively cap admission even with zero reported spend", async () => {
  const db = await admissionDatabase();
  try {
    const admitted = [];
    for (let n = 1; n <= 7; n++) {
      admitted.push(await claim(db, n));
      if (admitted[n - 1]) await finish(db, n, n % 2 ? "success" : "failure");
      // Keep the failure counter from tripping the unrelated two-failure stop.
      await db.query(
        "UPDATE public.code_runtime_controls SET consecutive_failures = 0, enabled = true, kill_switch = false, provider_usage_at = now()",
      );
    }
    assert.deepEqual(admitted, [true, true, true, true, true, false, false]);
    const held = await reservations(db);
    assert.equal(
      held.reduce((total, row) => total + row.reserved, 0),
      5,
    );
    assert.ok(held.every((row) => row.status === "finished"));
  } finally {
    await db.close();
  }
});

test("reported spend plus holds plus the new reservation must fit the daily limit", async () => {
  const db = await admissionDatabase();
  try {
    await addReportedSpend(db, 2.4);
    assert.equal(await claim(db, 1), true);
    await finish(db, 1);
    assert.equal(await claim(db, 2), true); // 2.4 + 1 hold + 1 = 4.4
    await finish(db, 2);
    assert.equal(await claim(db, 3), false); // 2.4 + 2 holds + 1 = 5.4
    await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now()");
    assert.equal((await reservations(db)).length, 2);
  } finally {
    await db.close();
  }
});

test("stale, missing, future and disabled prerequisites reserve nothing", async () => {
  const db = await admissionDatabase();
  try {
    const cases = [
      "provider_usage_at = now() - interval '6 minutes'",
      "provider_usage_at = NULL",
      "provider_usage_at = now() + interval '2 minutes'",
      "kill_switch = true",
      "enabled = false",
      "usage_spike = true",
      "consecutive_failures = 2",
    ];
    for (const [index, change] of cases.entries()) {
      await db.query(
        `UPDATE public.code_runtime_controls
         SET enabled = true, kill_switch = false, usage_spike = false, consecutive_failures = 0,
             provider_usage_at = now()`,
      );
      await db.query(`UPDATE public.code_runtime_controls SET ${change}`);
      assert.equal(await claim(db, index + 1), false, change);
    }
    assert.deepEqual(await reservations(db), []);
    await db.query(
      "UPDATE public.code_runtime_controls SET enabled = true, kill_switch = false, usage_spike = false, consecutive_failures = 0, provider_usage_at = now()",
    );
    assert.equal(await claim(db, 20), true);
  } finally {
    await db.close();
  }
});

test("a request can never reserve twice (replay) and reservations survive task outcomes", async () => {
  const db = await admissionDatabase();
  try {
    assert.equal(await claim(db, 1), true);
    await finish(db, 1, "cancelled");
    await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now()");
    assert.equal(await claim(db, 1), false);
    assert.equal((await reservations(db)).length, 1);
    const [row] = await reservations(db);
    assert.equal(row.status, "finished");
    assert.equal(row.outcome, "cancelled");
    assert.equal(row.released, 0);
  } finally {
    await db.close();
  }
});

test("emergency stop blocks new reservations and an active hold is kept until the task finishes", async () => {
  const db = await admissionDatabase();
  try {
    assert.equal(await claim(db, 1), true);
    await db.query("SELECT * FROM public.engage_code_kill_switch($1)", [ownerId]);
    const during = await reservations(db);
    assert.equal(during[0].status, "reserved");
    assert.equal(await claim(db, 2), false);
    assert.equal((await reservations(db)).length, 1);
    await finish(db, 1, "cancelled");
    const [row] = await reservations(db);
    assert.equal(row.status, "finished");
    assert.equal(row.released, 0);
  } finally {
    await db.close();
  }
});

test("finishing without a recorded reservation records a conservative hold instead of failing open", async () => {
  const db = await admissionDatabase();
  try {
    await seedRequest(db, 1);
    await db.query(
      "UPDATE public.code_runtime_controls SET active_request_id = $1, active_run_id = 1001",
      [rid(1)],
    );
    await finish(db, 1, "failure");
    const [row] = await reservations(db);
    assert.deepEqual(
      { status: row.status, reserved: row.reserved, outcome: row.outcome },
      { status: "finished", reserved: 1, outcome: "failure" },
    );
  } finally {
    await db.close();
  }
});

test("reservation rows are append-only history", async () => {
  const db = await admissionDatabase();
  try {
    assert.equal(await claim(db, 1), true);
    await assert.rejects(db.query("DELETE FROM public.code_spend_reservations"), /append-only/);
    await assert.rejects(
      db.query("UPDATE public.code_spend_reservations SET reserved_usd = 0.01"),
      /not allowed/,
    );
    await finish(db, 1);
    await assert.rejects(
      db.query("UPDATE public.code_spend_reservations SET status = 'reserved'"),
      /not allowed/,
    );
  } finally {
    await db.close();
  }
});

// Test-only time travel: the append-only trigger forbids editing timestamps, so disable it briefly.
async function backdate(db, sql, params = []) {
  await db.exec(
    "ALTER TABLE public.code_spend_reservations DISABLE TRIGGER code_spend_reservations_guard",
  );
  try {
    await db.query(sql, params);
  } finally {
    await db.exec(
      "ALTER TABLE public.code_spend_reservations ENABLE TRIGGER code_spend_reservations_guard",
    );
  }
}

async function reconcileFixture(db, { finishedAgoSeconds, createdAgoSeconds }) {
  await claim(db, 1);
  await finish(db, 1);
  await backdate(
    db,
    `UPDATE public.code_spend_reservations
     SET created_at = now() - make_interval(secs => $1), finished_at = now() - make_interval(secs => $2)`,
    [createdAgoSeconds, finishedAgoSeconds],
  );
}

const sync = (db, atIso = new Date().toISOString()) => {
  const day = new Date(atIso);
  day.setUTCHours(0, 0, 0, 0);
  return db.query("SELECT public.record_code_provider_costs($1, $2::jsonb, $3::timestamptz)", [
    ownerId,
    JSON.stringify([
      {
        provider_event_id: "b".repeat(64),
        source: "openai_org_costs",
        occurred_at: day.toISOString(),
        cost_usd: 0.4,
        request_id: null,
      },
    ]),
    atIso,
  ]);
};
const reconcile = async (db, actor = ownerId) =>
  (await db.query("SELECT public.reconcile_code_spend_reservations($1) AS n", [actor])).rows[0].n;

test(
  "reconciliation refunds a finished hold only after a later same-day provider cost report",
  { skip: secondsIntoUtcDay() < 1500 && "within 25 minutes of UTC midnight" },
  async () => {
    const db = await admissionDatabase();
    try {
      await reconcileFixture(db, { finishedAgoSeconds: 1000, createdAgoSeconds: 1100 });
      assert.equal(await reconcile(db), 0, "no provider cost report has been synced yet");
      await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now()");
      assert.equal(await claim(db, 2), true, "a hold still fits the limit while unsettled");
      await finish(db, 2);
      await backdate(
        db,
        "UPDATE public.code_spend_reservations SET created_at = now() - interval '300 seconds', finished_at = now() - interval '100 seconds' WHERE request_id = $1",
        [rid(2)],
      );
      await sync(db);
      assert.equal(await reconcile(db), 1, "only the hold older than the grace period is settled");
      const rows = await reservations(db);
      assert.deepEqual(
        rows.map((row) => [row.status, row.released]),
        [
          ["settled", 1],
          ["finished", 0],
        ],
      );
      const audit = await db.query(
        "SELECT detail FROM public.audit_logs WHERE action = 'code.spend_reconciled'",
      );
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].detail.released_usd, 1);
      assert.equal(await reconcile(db), 0, "reconciliation is idempotent");
      await assert.rejects(
        db.query(
          "UPDATE public.code_spend_reservations SET released_usd = 0 WHERE status = 'settled'",
        ),
        /not allowed/,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "refund restores admission capacity that holds had consumed",
  { skip: secondsIntoUtcDay() < 1500 && "within 25 minutes of UTC midnight" },
  async () => {
    const db = await admissionDatabase();
    try {
      for (let n = 1; n <= 5; n++) {
        assert.equal(await claim(db, n), true);
        await finish(db, n);
        await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now()");
      }
      assert.equal(await claim(db, 6), false);
      await backdate(
        db,
        "UPDATE public.code_spend_reservations SET created_at = now() - interval '2000 seconds', finished_at = now() - interval '1000 seconds'",
      );
      await sync(db);
      assert.equal(await reconcile(db), 5);
      await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now()");
      assert.equal(await claim(db, 6), true, "0.4 reported + 1 reservation fits again");
    } finally {
      await db.close();
    }
  },
);

test("reconciliation never releases early, cross-day, unfinished or unauthorized holds", async () => {
  const db = await admissionDatabase();
  try {
    await reconcileFixture(db, { finishedAgoSeconds: 100, createdAgoSeconds: 200 });
    await sync(db);
    assert.equal(await reconcile(db), 0, "inside the grace period");

    await backdate(
      db,
      "UPDATE public.code_spend_reservations SET created_at = now() - interval '2 days', finished_at = now() - interval '1 day'",
    );
    assert.equal(await reconcile(db), 0, "task spanned UTC days");

    await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now()");
    assert.equal(await claim(db, 2), true);
    await backdate(
      db,
      "UPDATE public.code_spend_reservations SET created_at = now() - interval '9000 seconds' WHERE request_id = $1",
      [rid(2)],
    );
    assert.equal(await reconcile(db), 0, "an active task is never reconciled");

    await assert.rejects(reconcile(db, nonOwnerId), /Only the owner/);
    await assert.rejects(reconcile(db, null), /Only the owner/);
    const rows = await reservations(db);
    assert.deepEqual(rows.map((row) => row.status).sort(), ["finished", "reserved"]);
  } finally {
    await db.close();
  }
});

test("a failed migration is atomic and leaves 0037/0038 behaviour untouched", async () => {
  const db = await baseDatabase();
  try {
    await db.exec("CREATE TABLE public.code_spend_reservations (id int)");
    await assert.rejects(up(db), /already exists/i);
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'code_runtime_controls' AND column_name = 'per_task_reserve_usd'`,
    );
    assert.equal(columns.rows.length, 0);
    const def = await db.query(
      "SELECT pg_get_functiondef('public.claim_code_runtime_slot(uuid,text,text,text,bigint)'::regprocedure) AS def",
    );
    assert.doesNotMatch(def.rows[0].def, /code_spend_reservations/);
  } finally {
    await db.close();
  }
});

test("rollback refuses while holds are unsettled, then restores 0037 behaviour and re-applies", async () => {
  const db = await admissionDatabase();
  try {
    const down = await readFile("drizzle/rollbacks/0040_code_spend_reservations.down.sql", "utf8");
    assert.equal(await claim(db, 1), true);
    await assert.rejects(db.exec(down), /Unsettled CODE spend reservations/);
    await finish(db, 1);
    await assert.rejects(db.exec(down), /Unsettled CODE spend reservations/);
    await db.query(
      "UPDATE public.code_spend_reservations SET status = 'settled', released_usd = reserved_usd, settled_at = now()",
    );
    await db.exec(down);

    const gone = await db.query(
      "SELECT to_regclass('public.code_spend_reservations') AS t, to_regprocedure('public.reconcile_code_spend_reservations(uuid)') AS f",
    );
    assert.deepEqual(gone.rows[0], { t: null, f: null });
    const def = await db.query(
      "SELECT pg_get_functiondef('public.claim_code_runtime_slot(uuid,text,text,text,bigint)'::regprocedure) AS def",
    );
    assert.doesNotMatch(def.rows[0].def, /reserv/);

    await db.query(
      "UPDATE public.code_runtime_controls SET provider_usage_at = now(), enabled = true, kill_switch = false",
    );
    assert.equal(await claim(db, 2), true, "0037 admission works again after rollback");

    await finish(db, 2);
    await up(db);
    assert.equal(
      (await reservations(db)).length,
      0,
      "re-applying the migration works on rolled-back state",
    );
  } finally {
    await db.close();
  }
});

test("the rollback keeps the provider hard-cap invariant intact on the real schema", async () => {
  const db = await baseDatabase();
  try {
    await up(db);
    await db.exec(
      await readFile("drizzle/rollbacks/0040_code_spend_reservations.down.sql", "utf8"),
    );
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
      /check constraint/i,
    );
  } finally {
    await db.close();
  }
});

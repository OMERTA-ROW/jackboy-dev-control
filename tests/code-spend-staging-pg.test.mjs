import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// Real-PostgreSQL staging checks. Skipped unless STAGING_PG_URL points at a LOOPBACK disposable
// server. Each test creates and force-drops its own throwaway database; synthetic data only; no
// provider, GitHub or production system is reachable. The 0037 hard-cap CHECK is dropped in the
// throwaway database ONLY, because the real schema can never admit a task by design.
const url = process.env.STAGING_PG_URL;
const skip = url ? false : "STAGING_PG_URL not set (no disposable PostgreSQL available)";
const ownerId = "00000000-0000-4000-8000-000000000001";
const nonOwnerId = "00000000-0000-4000-8000-000000000009";
const sha = "a".repeat(40);
const repo = "owner/repo";
const rid = (n) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;

let pg;
let admin;
async function open() {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error("STAGING_PG_URL must be a loopback host");
  }
  pg ??= createRequire(process.env.STAGING_PG_MODULE_FROM ?? import.meta.url)("pg");
  admin ??= new pg.Pool({ connectionString: url, max: 2 });
  const name = `stg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 16 });
  await pool.query(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE public.action_requests (id uuid PRIMARY KEY, requested_by uuid NOT NULL, status text NOT NULL,
      runner_claimed_at timestamptz, runner_run_id bigint, runner_run_attempt integer,
      resources jsonb NOT NULL DEFAULT '{}'::jsonb, outcome text);
    CREATE TABLE public.omni_connection (config_hash text);
    CREATE TABLE public.audit_logs (actor uuid, action text NOT NULL, detail jsonb NOT NULL, outcome text NOT NULL);
    CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);`);
  for (const f of [
    "0036_code_runner_claims",
    "0037_code_safety_controls",
    "0038_code_provider_costs",
    "0040_code_spend_reservations",
  ]) {
    await pool.query(await readFile(`drizzle/migrations/${f}.sql`, "utf8"));
  }
  await pool.query("INSERT INTO public.user_roles VALUES ($1,'owner')", [ownerId]);
  await pool.query(
    "ALTER TABLE public.code_runtime_controls DROP CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check",
  );
  await pool.query(
    `UPDATE public.code_runtime_controls SET enabled=true, kill_switch=false, provider_hard_cap_verified=true,
       provider_usage_at=now(), allowed_targets=$1::jsonb`,
    [JSON.stringify({ [repo]: { ref: "main", workflowSha: sha } })],
  );
  return {
    pool,
    close: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    },
  };
}
const seed = (pool, n) =>
  pool.query(
    `INSERT INTO public.action_requests VALUES ($1,$2,'allowed',now(),$3,1,$4::jsonb,NULL) ON CONFLICT DO NOTHING`,
    [rid(n), ownerId, 1000 + n, JSON.stringify({ repo, ref: "main", workflowSha: sha })],
  );
const claimSql = "SELECT public.claim_code_runtime_slot($1,$2,'main',$3,$4) AS c";
const claim = async (pool, n) =>
  (await pool.query(claimSql, [rid(n), repo, sha, 1000 + n])).rows[0].c;
const finish = (pool, n, o = "success") =>
  pool.query("SELECT public.finish_code_runtime_slot($1,$2,1,$3)", [rid(n), 1000 + n, o]);
const held = async (pool) =>
  (
    await pool.query(
      "SELECT count(*)::int n, coalesce(sum(reserved_usd),0)::float usd FROM public.code_spend_reservations WHERE status<>'settled'",
    )
  ).rows[0];

test(
  "server is real PostgreSQL and no production-style credentials are in use",
  { skip },
  async () => {
    const { pool, close } = await open();
    try {
      const v =
        (await pool.query("SHOW server_version")).rows[0].server_version_num ??
        (await pool.query("SELECT version() v")).rows[0].v;
      assert.ok(v);
      assert.match(new URL(url).hostname, /^(127\.0\.0\.1|localhost|::1|\[::1\])$/);
    } finally {
      await close();
    }
  },
);

test(
  "parallel workers on separate connections never admit more than the daily limit",
  { skip },
  async () => {
    const { pool, close } = await open();
    try {
      const limit = 5;
      await pool.query(
        "UPDATE public.code_runtime_controls SET daily_spend_limit_usd=$1, per_task_reserve_usd=1",
        [limit],
      );
      for (let n = 1; n <= 40; n++) await seed(pool, n);
      const pids = new Set();
      const admitted = [];
      const worker = async (ids) => {
        for (const n of ids) {
          const c = await pool.connect();
          try {
            pids.add((await c.query("SELECT pg_backend_pid() p")).rows[0].p);
            const ok = (await c.query(claimSql, [rid(n), repo, sha, 1000 + n])).rows[0].c;
            if (ok) {
              admitted.push(n);
              await c.query("SELECT public.finish_code_runtime_slot($1,$2,1,'success')", [
                rid(n),
                1000 + n,
              ]);
            }
          } finally {
            c.release();
          }
        }
      };
      await Promise.all(
        Array.from({ length: 16 }, (_, w) =>
          worker([w + 1, w + 17, w + 33].filter((n) => n <= 40)),
        ),
      );
      assert.ok(pids.size > 1, "work ran on multiple backend connections");
      const h = await held(pool);
      assert.equal(h.n, admitted.length);
      assert.ok(h.usd <= limit, `holds ${h.usd} within limit ${limit}`);
      // Drain sequentially: capacity must end at exactly the limit, never beyond.
      for (let n = 1; n <= 40; n++)
        if (!admitted.includes(n) && (await claim(pool, n))) {
          admitted.push(n);
          await finish(pool, n);
        }
      assert.equal((await held(pool)).usd, limit);
      assert.equal(admitted.length, limit);
      const dup = await pool.query(
        "SELECT request_id FROM public.code_spend_reservations GROUP BY 1 HAVING count(*)>1",
      );
      assert.equal(dup.rowCount, 0);
    } finally {
      await close();
    }
  },
);

test(
  "a competing claim blocks on the controls row lock until the first transaction ends",
  { skip },
  async () => {
    const { pool, close } = await open();
    try {
      await seed(pool, 1);
      await seed(pool, 2);
      const a = await pool.connect();
      await a.query("BEGIN");
      assert.equal((await a.query(claimSql, [rid(1), repo, sha, 1001])).rows[0].c, true);
      const b = await pool.connect();
      const bPid = (await b.query("SELECT pg_backend_pid() p")).rows[0].p;
      const pending = b.query(claimSql, [rid(2), repo, sha, 1002]);
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        await new Promise((r) => setTimeout(r, 40));
        waiting =
          (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [bPid]))
            .rows[0]?.wait_event_type === "Lock";
      }
      assert.ok(waiting, "second claim is blocked on a row lock (serialised, not racing)");
      await a.query("COMMIT");
      assert.equal((await pending).rows[0].c, false, "after the first commit the slot is taken");
      a.release();
      b.release();
      assert.deepEqual(await held(pool), { n: 1, usd: 1 });
    } finally {
      await close();
    }
  },
);

test("a rolled-back claim leaves no hold and no active slot", { skip }, async () => {
  const { pool, close } = await open();
  try {
    await seed(pool, 1);
    const c = await pool.connect();
    await c.query("BEGIN");
    assert.equal((await c.query(claimSql, [rid(1), repo, sha, 1001])).rows[0].c, true);
    await c.query("ROLLBACK");
    c.release();
    assert.deepEqual(await held(pool), { n: 0, usd: 0 });
    assert.equal(
      (await pool.query("SELECT active_request_id FROM public.code_runtime_controls")).rows[0]
        .active_request_id,
      null,
    );
    assert.equal(await claim(pool, 1), true, "request can still be admitted after rollback");
  } finally {
    await close();
  }
});

test("audit-log failure aborts the claim atomically (no hold, no slot)", { skip }, async () => {
  const { pool, close } = await open();
  try {
    await seed(pool, 1);
    await pool.query(`CREATE FUNCTION public.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER audit_boom BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.boom();`);
    await assert.rejects(claim(pool, 1), /audit unavailable/);
    assert.deepEqual(await held(pool), { n: 0, usd: 0 });
    assert.equal(
      (await pool.query("SELECT active_request_id FROM public.code_runtime_controls")).rows[0]
        .active_request_id,
      null,
    );
    await pool.query("DROP TRIGGER audit_boom ON public.audit_logs");
    assert.equal(await claim(pool, 1), true, "recovers once audit logging is healthy");
  } finally {
    await close();
  }
});

test(
  "metering failures fail closed: unreadable usage table, missing and stale evidence",
  { skip },
  async () => {
    const { pool, close } = await open();
    try {
      await seed(pool, 1);
      await pool.query("ALTER TABLE public.code_usage_events RENAME TO code_usage_events_gone");
      await assert.rejects(claim(pool, 1));
      await pool.query("ALTER TABLE public.code_usage_events_gone RENAME TO code_usage_events");
      for (const v of ["NULL", "now() - interval '6 minutes'", "now() + interval '1 minute'"]) {
        await pool.query(`UPDATE public.code_runtime_controls SET provider_usage_at = ${v}`);
        assert.equal(await claim(pool, 1), false, v);
      }
      assert.deepEqual(await held(pool), { n: 0, usd: 0 });
    } finally {
      await close();
    }
  },
);

test(
  "database privileges: anon/authenticated cannot claim, finish, reconcile or read holds",
  { skip },
  async () => {
    const { pool, close } = await open();
    try {
      await seed(pool, 1);
      for (const role of ["anon", "authenticated"]) {
        const c = await pool.connect();
        try {
          await c.query(`SET ROLE ${role}`);
          await assert.rejects(c.query(claimSql, [rid(1), repo, sha, 1001]), /permission denied/);
          await assert.rejects(
            c.query("SELECT public.reconcile_code_spend_reservations($1)", [ownerId]),
            /permission denied/,
          );
          await assert.rejects(
            c.query("SELECT * FROM public.code_spend_reservations"),
            /permission denied/,
          );
        } finally {
          await c.query("RESET ROLE");
          c.release();
        }
      }
      assert.deepEqual(await held(pool), { n: 0, usd: 0 });
    } finally {
      await close();
    }
  },
);

test(
  "cost-report lifecycle on real PostgreSQL: hold, finish, report, reconcile, refund; non-owner denied",
  { skip },
  async () => {
    const { pool, close } = await open();
    try {
      await pool.query(
        "UPDATE public.code_runtime_controls SET daily_spend_limit_usd=2, per_task_reserve_usd=1",
      );
      for (const n of [1, 2, 3]) await seed(pool, n);
      assert.equal(await claim(pool, 1), true);
      await finish(pool, 1, "failure");
      assert.equal(await claim(pool, 2), true);
      await finish(pool, 2, "cancelled");
      assert.equal(await claim(pool, 3), false, "two unreconciled holds exhaust a $2 limit");
      const secs = (
        await pool.query(
          "SELECT extract(epoch FROM now() - date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int s",
        )
      ).rows[0].s;
      if (secs < 25 * 60) return; // same-UTC-day assertions are meaningless right after midnight
      await pool.query(
        "ALTER TABLE public.code_spend_reservations DISABLE TRIGGER code_spend_reservations_guard",
      );
      await pool.query(
        "UPDATE public.code_spend_reservations SET created_at = now() - interval '20 minutes', finished_at = now() - interval '18 minutes'",
      );
      await pool.query(
        "ALTER TABLE public.code_spend_reservations ENABLE TRIGGER code_spend_reservations_guard",
      );
      await pool.query(
        "UPDATE public.code_runtime_controls SET provider_costs_synced_at = now(), provider_usage_at = now()",
      );
      await assert.rejects(
        pool.query("SELECT public.reconcile_code_spend_reservations($1)", [nonOwnerId]),
      );
      assert.equal(
        (await pool.query("SELECT public.reconcile_code_spend_reservations($1) n", [ownerId]))
          .rows[0].n,
        2,
      );
      assert.equal(
        (await pool.query("SELECT public.reconcile_code_spend_reservations($1) n", [ownerId]))
          .rows[0].n,
        0,
      );
      assert.deepEqual(await held(pool), { n: 0, usd: 0 });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM public.audit_logs WHERE action='code.spend_reconciled'",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(await claim(pool, 3), true, "refund restored capacity");
    } finally {
      await close();
    }
  },
);

test(
  "a hold that crosses a UTC day is never auto-released and keeps counting (documented gap)",
  { skip },
  async () => {
    const { pool, close } = await open();
    try {
      await pool.query(
        "UPDATE public.code_runtime_controls SET daily_spend_limit_usd=1, per_task_reserve_usd=1",
      );
      await seed(pool, 1);
      await seed(pool, 2);
      assert.equal(await claim(pool, 1), true);
      await finish(pool, 1);
      await pool.query(
        "ALTER TABLE public.code_spend_reservations DISABLE TRIGGER code_spend_reservations_guard",
      );
      await pool.query(
        "UPDATE public.code_spend_reservations SET created_at = now() - interval '2 days', finished_at = now() - interval '2 days' + interval '1 minute'",
      );
      await pool.query(
        "ALTER TABLE public.code_spend_reservations ENABLE TRIGGER code_spend_reservations_guard",
      );
      await pool.query(
        "UPDATE public.code_runtime_controls SET provider_costs_synced_at = now(), provider_usage_at = now()",
      );
      assert.equal(
        (await pool.query("SELECT public.reconcile_code_spend_reservations($1) n", [ownerId]))
          .rows[0].n,
        0,
      );
      assert.equal(
        await claim(pool, 2),
        false,
        "stale prior-day hold still blocks today's capacity (fail closed)",
      );
    } finally {
      await close();
    }
  },
);

process.on("exit", () => admin?.end());

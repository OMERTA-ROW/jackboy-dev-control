import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  skipNoPg,
  openDb,
  supabaseStubs,
  replay,
  setActivatedControls,
  closeAdmin,
  dropClosedDatabase,
} from "./helpers/staging-pg.mjs";

// Real-PostgreSQL tests for the 0042 provider-call ledger (loopback disposable server, synthetic data).
after(closeAdmin);

test("disposable cleanup drains closing clients and never force-terminates connections", async () => {
  const statements = [];
  let polls = 0;
  const connection = {
    query: async (sql) => {
      statements.push(sql);
      return { rows: [{ n: ++polls === 1 ? 1 : 0 }] };
    },
  };
  await dropClosedDatabase(connection, "chain_123456_abcdef");
  assert.equal(statements.filter((sql) => sql.includes("pg_stat_activity")).length, 2);
  assert.equal(statements.at(-1), "DROP DATABASE chain_123456_abcdef");
  assert.ok(statements.every((sql) => !sql.includes("FORCE")));
  const before = statements.length;
  await assert.rejects(dropClosedDatabase(connection, "postgres"), /non-test database/);
  assert.equal(statements.length, before);
});

const owner = randomUUID();
let keySeq = 0;
const key = () => `call${String(++keySeq).padStart(8, "0")}`;

async function setup({ reserved = 2, run = true, through } = {}) {
  const db = await openDb();
  await db.exec(supabaseStubs);
  await replay(db, through ? { through } : {});
  await db.query("INSERT INTO auth.users(id, email) VALUES ($1, 'o@example.test')", [owner]);
  await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [owner]);
  const id = randomUUID();
  await db.query(
    `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt)
     VALUES ($1, 'code', 'high', 'n', now() + interval '1 hour', $2, 'allowed', now(), 7, 1)`,
    [id, owner],
  );
  await db.query(
    `INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd, status) VALUES ($1, 7, $2, 'reserved')`,
    [id, reserved],
  );
  if (run) {
    await setActivatedControls(
      db,
      "UPDATE public.code_runtime_controls SET enabled = true, kill_switch = false, active_request_id = $1, active_run_id = 7",
      [id],
    );
  }
  return { db, id };
}

const admit = (db, id, ceiling, { run = 7, k = key() } = {}) =>
  db.query("SELECT public.admit_code_provider_call($1, $2, $3, 'm-test', $4) AS id", [
    id,
    run,
    k,
    ceiling,
  ]);
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const call = (db, cid) =>
  one(
    db,
    "SELECT status, actual_usd::float AS actual, overrun FROM public.code_provider_calls WHERE id = $1",
    [cid],
  );
const holds = async (db, id) =>
  (await one(db, "SELECT public.code_provider_call_holds($1)::float AS h", [id])).h;
const audits = async (db, action) =>
  (await one(db, "SELECT count(*)::int AS n FROM public.audit_logs WHERE action = $1", [action])).n;
const killed = async (db) =>
  (await one(db, "SELECT kill_switch FROM public.code_runtime_controls")).kill_switch;

test("concurrent admissions never exceed the task reservation", { skip: skipNoPg }, async () => {
  const { db, id } = await setup({ reserved: 2 });
  try {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => admit(db, id, 0.5)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 4);
    assert.equal(await holds(db, id), 2);
    assert.equal((await one(db, "SELECT count(*)::int n FROM public.code_provider_calls")).n, 4);
    assert.equal(await audits(db, "code.provider_call_admitted"), 4);
  } finally {
    await db.close();
  }
});

test("admission fails closed without an authorised runtime", { skip: skipNoPg }, async () => {
  const { db, id } = await setup();
  try {
    await db.query("UPDATE public.code_runtime_controls SET kill_switch = true");
    await assert.rejects(admit(db, id, 0.1), /not authorised/);
    await setActivatedControls(
      db,
      "UPDATE public.code_runtime_controls SET kill_switch = false, enabled = false",
    );
    await assert.rejects(admit(db, id, 0.1), /not authorised/);
    await setActivatedControls(
      db,
      "UPDATE public.code_runtime_controls SET enabled = true, stop_requested_at = now()",
    );
    await assert.rejects(admit(db, id, 0.1), /not authorised/);
    await db.query(
      "UPDATE public.code_runtime_controls SET stop_requested_at = null, cancellation_status = 'requested'",
    );
    await assert.rejects(admit(db, id, 0.1), /not authorised/);
    await db.query("UPDATE public.code_runtime_controls SET cancellation_status = 'not_needed'");
    await assert.rejects(admit(db, id, 0.1, { run: 8 }), /not authorised/);
    await assert.rejects(admit(db, randomUUID(), 0.1), /not authorised/);
    await assert.rejects(admit(db, id, 0), /invalid request|violates/);
    await assert.rejects(admit(db, id, 6), /would be exceeded|violates/);
    assert.equal((await one(db, "SELECT count(*)::int n FROM public.code_provider_calls")).n, 0);
  } finally {
    await db.close();
  }
});

test("admission needs an active reservation", { skip: skipNoPg }, async () => {
  const { db, id } = await setup();
  try {
    await db
      .query(
        "UPDATE public.code_spend_reservations SET status = 'finished', outcome = 'success', finished_at = now() WHERE request_id = $1",
        [id],
      )
      .catch(() => {});
    const st = (
      await one(db, "SELECT status FROM public.code_spend_reservations WHERE request_id=$1", [id])
    ).status;
    if (st === "reserved")
      await db
        .query("DELETE FROM public.code_spend_reservations WHERE request_id=$1", [id])
        .catch(() => {});
    await assert.rejects(admit(db, id, 0.1), /no active spend reservation|not authorised/);
  } finally {
    await db.close();
  }
});

test(
  "Emergency Stop blocks dispatch of an admitted call and abort frees the hold",
  { skip: skipNoPg },
  async () => {
    const { db, id } = await setup();
    try {
      const cid = (await admit(db, id, 0.5)).rows[0].id;
      await db.query("UPDATE public.code_runtime_controls SET kill_switch = true");
      await assert.rejects(
        db.query("SELECT public.dispatch_code_provider_call($1)", [cid]),
        /dispatch blocked/,
      );
      assert.equal((await call(db, cid)).status, "admitted");
      await db.query("SELECT public.abort_code_provider_call($1, 'stopped')", [cid]);
      assert.equal((await call(db, cid)).status, "aborted");
      assert.equal(await holds(db, id), 0);
      await assert.rejects(
        db.query("SELECT public.dispatch_code_provider_call($1)", [cid]),
        /dispatch blocked/,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "abort is impossible after dispatch; settle is single-shot; terminal rows are immutable",
  { skip: skipNoPg },
  async () => {
    const { db, id } = await setup();
    try {
      const cid = (await admit(db, id, 0.5)).rows[0].id;
      await db.query("SELECT public.dispatch_code_provider_call($1)", [cid]);
      await assert.rejects(
        db.query("SELECT public.abort_code_provider_call($1, 'late')", [cid]),
        /never dispatched/,
      );
      await db.query("SELECT public.settle_code_provider_call($1, 0.2, 'req_1')", [cid]);
      assert.deepEqual(await call(db, cid), { status: "settled", actual: 0.2, overrun: false });
      assert.equal(await holds(db, id), 0.2);
      await assert.rejects(
        db.query("SELECT public.settle_code_provider_call($1, 0.1, 'req_2')", [cid]),
        /dispatched call can be settled/,
      );
      await assert.rejects(
        db.query("UPDATE public.code_provider_calls SET actual_usd = 0 WHERE id = $1", [cid]),
        /not allowed/,
      );
      await assert.rejects(
        db.query("DELETE FROM public.code_provider_calls WHERE id = $1", [cid]),
        /append-only/,
      );
    } finally {
      await db.close();
    }
  },
);

test("an unknown outcome keeps the full ceiling reserved", { skip: skipNoPg }, async () => {
  const { db, id } = await setup({ reserved: 1 });
  try {
    const cid = (await admit(db, id, 0.8)).rows[0].id;
    await assert.rejects(
      db.query("SELECT public.mark_code_provider_call_unknown($1, 'x')", [cid]),
      /dispatched call/,
    );
    await db.query("SELECT public.dispatch_code_provider_call($1)", [cid]);
    await db.query("SELECT public.mark_code_provider_call_unknown($1, 'stream cut')", [cid]);
    assert.equal((await call(db, cid)).status, "unknown");
    assert.equal(await holds(db, id), 0.8);
    await assert.rejects(admit(db, id, 0.3), /would be exceeded/);
    await assert.rejects(
      db.query("SELECT public.settle_code_provider_call($1, 0, null)", [cid]),
      /dispatched call can be settled/,
    );
  } finally {
    await db.close();
  }
});

test(
  "an overrun is recorded at the provider figure and engages Emergency Stop",
  { skip: skipNoPg },
  async () => {
    const { db, id } = await setup();
    try {
      const cid = (await admit(db, id, 0.5)).rows[0].id;
      await db.query("SELECT public.dispatch_code_provider_call($1)", [cid]);
      await db.query("SELECT public.settle_code_provider_call($1, 0.9, 'req_o')", [cid]);
      assert.deepEqual(await call(db, cid), { status: "settled", actual: 0.9, overrun: true });
      assert.equal(await killed(db), true);
      assert.equal(await audits(db, "code.provider_call_overrun"), 1);
      await assert.rejects(admit(db, id, 0.1), /not authorised/);
    } finally {
      await db.close();
    }
  },
);

test(
  "only service_role can run gateway functions; the internal cost applier is unreachable",
  { skip: skipNoPg },
  async () => {
    const { db, id } = await setup();
    try {
      const cid = (await admit(db, id, 0.5)).rows[0].id;
      for (const role of ["anon", "authenticated", "service_role"]) {
        await db.query(`SET ROLE ${role}`);
        const attempt = db.query("SELECT public.apply_code_provider_call_cost($1, 0, null, 'x')", [
          cid,
        ]);
        await assert.rejects(attempt, /permission denied/);
        await db.query("RESET ROLE");
      }
      for (const role of ["anon", "authenticated"]) {
        await db.query(`SET ROLE ${role}`);
        await assert.rejects(admit(db, id, 0.1), /permission denied/);
        await db.query("RESET ROLE");
      }
    } finally {
      await db.close();
    }
  },
);

async function backdate(db, cid, daysAgo) {
  await db.query("ALTER TABLE public.code_provider_calls DISABLE TRIGGER USER");
  await db.query(
    `UPDATE public.code_provider_calls SET dispatched_at = (((now() AT TIME ZONE 'UTC')::date - ${daysAgo})::timestamp + interval '12 hours') AT TIME ZONE 'UTC' WHERE id = $1`,
    [cid],
  );
  await db.query("ALTER TABLE public.code_provider_calls ENABLE TRIGGER USER");
}
const dayStr = (db, daysAgo) =>
  one(
    db,
    `SELECT to_char((now() AT TIME ZONE 'UTC')::date - ${daysAgo}, 'YYYY-MM-DD') d, (((now() AT TIME ZONE 'UTC')::date - ${daysAgo})::timestamp AT TIME ZONE 'UTC') start`,
  );
async function dayReport(db, daysAgo, cost) {
  const day = await dayStr(db, daysAgo);
  await db.query(
    "SELECT public.record_code_closed_day_costs($1, $2::date, $3::jsonb, now() - interval '12 hours')",
    [
      owner,
      day.d,
      JSON.stringify([
        {
          provider_event_id: "ab".repeat(32),
          source: "openai_org_costs",
          occurred_at: day.start,
          cost_usd: cost,
          request_id: null,
        },
      ]),
    ],
  );
  return day;
}

test(
  "owner resolution of an unknown call needs closed-day provider evidence",
  { skip: skipNoPg },
  async () => {
    const { db, id } = await setup();
    try {
      const cid = (await admit(db, id, 0.5)).rows[0].id;
      await db.query("SELECT public.dispatch_code_provider_call($1)", [cid]);
      await db.query("SELECT public.mark_code_provider_call_unknown($1, 'cut')", [cid]);
      const resolve = (actor = owner, reason = "verified against the provider cost report") =>
        db.query("SELECT public.resolve_code_provider_call($1, $2, 0.3, $3)", [actor, cid, reason]);
      await assert.rejects(resolve(), /No authoritative provider cost evidence/);
      await backdate(db, cid, 2);
      await assert.rejects(resolve(), /No authoritative provider cost evidence/);
      await dayReport(db, 2, 0.3);
      await assert.rejects(resolve(randomUUID()), /Only the owner/);
      await assert.rejects(resolve(owner, "short"), /Invalid/);
      assert.equal((await call(db, cid)).status, "unknown");
      await resolve();
      assert.deepEqual(await call(db, cid), { status: "settled", actual: 0.3, overrun: false });
      assert.equal(await audits(db, "code.provider_call_resolved"), 1);
      await assert.rejects(resolve(), /not awaiting resolution/);
    } finally {
      await db.close();
    }
  },
);

test(
  "a failing audit write rolls the admission back (fail closed)",
  { skip: skipNoPg },
  async () => {
    const { db, id } = await setup();
    try {
      await db.exec(`
      CREATE FUNCTION public.deny_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER deny_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.deny_audit();`);
      await assert.rejects(admit(db, id, 0.5), /audit unavailable/);
      assert.equal((await one(db, "SELECT count(*)::int n FROM public.code_provider_calls")).n, 0);
    } finally {
      await db.close();
    }
  },
);

test(
  "reconciliation flags provider spend the gateway never admitted",
  { skip: skipNoPg },
  async () => {
    const { db, id } = await setup();
    try {
      const cid = (await admit(db, id, 0.5)).rows[0].id;
      await db.query("SELECT public.dispatch_code_provider_call($1)", [cid]);
      await db.query("SELECT public.settle_code_provider_call($1, 0.2, 'r')", [cid]);
      await backdate(db, cid, 2);
      const day = await dayReport(db, 2, 0.2);
      const run = (actor = owner) =>
        db.query("SELECT public.reconcile_code_provider_day($1, $2::date) AS r", [actor, day.d]);
      await assert.rejects(run(randomUUID()), /Only the owner/);
      const good = (await run()).rows[0].r;
      assert.equal(good.ok, true);
      assert.equal(await killed(db), false);
      await db.query(
        "INSERT INTO public.code_usage_events(provider_event_id, source, occurred_at, cost_usd) VALUES ($1, 'openai_org_costs', $2, 3)",
        ["ef".repeat(32), day.start],
      );
      const bad = (await run()).rows[0].r;
      assert.equal(bad.ok, false);
      assert.ok(bad.unaccounted_usd > 2.9);
      assert.equal(await killed(db), true);
      assert.equal(
        (
          await one(
            db,
            "SELECT count(*)::int n FROM public.audit_logs WHERE outcome = 'bypass_suspected'",
          )
        ).n,
        1,
      );
      await assert.rejects(
        db.query(
          "SELECT public.reconcile_code_provider_day($1, (now() AT TIME ZONE 'UTC')::date)",
          [owner],
        ),
        /Invalid/,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "the 0037 hard-cap CHECK is untouched and 0042 cannot mark the cap verified",
  { skip: skipNoPg },
  async () => {
    const { db } = await setup({ through: "0045" });
    try {
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
        /violates check constraint/,
      );
      const sql = await readFile("drizzle/migrations/0042_code_provider_gateway.sql", "utf8");
      assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /provider_hard_cap_verified/);
    } finally {
      await db.close();
    }
  },
);

test(
  "0042 rolls back only when nothing is unresolved, then re-applies",
  { skip: skipNoPg },
  async () => {
    const { db, id } = await setup();
    try {
      const down = await readFile("drizzle/rollbacks/0042_code_provider_gateway.down.sql", "utf8");
      const up = await readFile("drizzle/migrations/0042_code_provider_gateway.sql", "utf8");
      const cid = (await admit(db, id, 0.5)).rows[0].id;
      await assert.rejects(db.query(down), /unresolved|refus/i);
      await db.query("SELECT public.abort_code_provider_call($1, 'done')", [cid]);
      await db.query(down);
      assert.equal((await one(db, "SELECT to_regclass('public.code_provider_calls') t")).t, null);
      await db.query(up);
      assert.equal((await one(db, "SELECT count(*)::int n FROM public.code_provider_calls")).n, 0);
    } finally {
      await db.close();
    }
  },
);

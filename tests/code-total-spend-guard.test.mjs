import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { supabaseStubs, migrationFiles } from "./helpers/staging-pg.mjs";

// In-memory PGlite only, synthetic IDs, no network, no provider calls. Replays the real applied
// migration chain, then the PROPOSED (unapplied) files under staging/code-activation/.

const owner = "93a2e690-a179-4d08-bd68-a3a793fced11";
const stranger = "00000000-0000-4000-8000-000000000009";
const repo = "OMERTA-ROW/jackboy-dev-control";
const oldSha = "ebc71c1923c3d6ab925ec6b9e4fa971e311f3761";
const newSha = "37368194f883bc1cf5175aecf4832945203b602b";
const rid = (n) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;
const proposed = (f) => readFile(`staging/code-activation/${f}`, "utf8");

let chain; // applied production chain + seed
let guarded; // + 0047
let gated; // + 0047 + 0048

before(async () => {
  chain = new PGlite();
  await chain.exec(supabaseStubs);
  for (const f of await migrationFiles()) {
    await chain.exec(await readFile(`drizzle/migrations/${f}`, "utf8"));
  }
  await chain.query("INSERT INTO auth.users(id, email) VALUES ($1, 'o@x.test'), ($2, 's@x.test')", [
    owner,
    stranger,
  ]);
  await chain.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [owner]);
  await chain.query("UPDATE public.code_runtime_controls SET allowed_targets = $1::jsonb", [
    JSON.stringify({ [repo]: { ref: "main", workflowSha: oldSha } }),
  ]);
  guarded = await chain.clone();
  await guarded.exec(await proposed("0047_code_total_spend_guard.sql"));
  gated = await guarded.clone();
  await gated.exec(await proposed("0048_code_hard_cap_gate.sql"));
});

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const controls = (db) =>
  one(
    db,
    `SELECT enabled, kill_switch, provider_hard_cap_verified AS verified, paused_reason,
            allowed_targets, total_spend_limit_usd::float AS total_limit
     FROM public.code_runtime_controls`,
  );
const committed = async (db) =>
  (await one(db, "SELECT public.code_total_spend_committed()::float AS c")).c;
const status = async (db) => (await one(db, "SELECT public.code_total_spend_guard_status() AS s")).s;
const audits = async (db, action) =>
  (await one(db, "SELECT count(*)::int AS n FROM public.audit_logs WHERE action = $1", [action])).n;

let ev = 0;
const usage = (db, usd, daysAgo = 3) =>
  db.query(
    `INSERT INTO public.code_usage_events(provider_event_id, source, occurred_at, cost_usd)
     VALUES ($1, 'openai_org_costs', now() - ($2 || ' days')::interval, $3)`,
    [`ev-${++ev}`, String(daysAgo), usd],
  );

async function request(db, n) {
  await db.query(
    `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status,
       runner_claimed_at, runner_run_id, runner_run_attempt, resources)
     VALUES ($1, 'code', 'high', 'n', now() + interval '1 hour', $2, 'allowed', now(), $3, 1, $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [rid(n), owner, 1000 + n, JSON.stringify({ repo, ref: "main", workflowSha: oldSha })],
  );
}
const claim = async (db, n) => {
  await request(db, n);
  return (
    await one(db, "SELECT public.claim_code_runtime_slot($1, $2, 'main', $3, $4) AS ok", [
      rid(n),
      repo,
      oldSha,
      1000 + n,
    ])
  ).ok;
};
const finish = (db, n, outcome = "success") =>
  db.query("SELECT public.finish_code_runtime_slot($1, $2, 1, $3)", [rid(n), 1000 + n, outcome]);
const attest = (db, verified = true, actor = owner) =>
  db.query("SELECT public.set_code_provider_hard_cap_verified($1, $2, $3)", [
    actor,
    verified,
    "Owner reviewed the cumulative guard test evidence",
  ]);
const run = (db) =>
  db.query(
    "UPDATE public.code_runtime_controls SET enabled = true, kill_switch = false, provider_usage_at = now()",
  );

// Gate opened the only allowed way, then CODE switched on (test database only).
async function openDb() {
  const db = await gated.clone();
  await attest(db);
  await run(db);
  return db;
}

test("0047 alone: $10 default, bounded limit, guard enforced, 0037 still forces the flag false", async () => {
  const db = await guarded.clone();
  const c = await controls(db);
  assert.equal(c.total_limit, 10);
  assert.equal(c.enabled, false);
  assert.equal(c.kill_switch, true);
  for (const v of [0, 10.01, -1]) {
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET total_spend_limit_usd = $1", [v]),
      /check constraint/i,
    );
  }
  const s = await status(db);
  assert.equal(s.enforced, true);
  assert.deepEqual(s.missing, []);
  assert.equal(Number(s.committed_usd), 0);
  await assert.rejects(
    db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
    /check constraint/i,
  );
  await run(db);
  assert.equal(await claim(db, 1), false, "claims stay blocked until the gate is reviewed");
  const grants = await one(
    db,
    `SELECT has_function_privilege('anon', 'public.code_total_spend_guard_status()', 'EXECUTE') AS anon,
            has_function_privilege('authenticated', 'public.code_total_spend_committed()', 'EXECUTE') AS auth,
            has_function_privilege('service_role', 'public.code_total_spend_guard_status()', 'EXECUTE') AS service`,
  );
  assert.deepEqual(grants, { anon: false, auth: false, service: true });
});

test("claims stop at the cumulative $10 total even when the daily limit has room", async () => {
  const db = await openDb();
  await usage(db, 8.0); // reported three days ago: counts toward the total, not today's daily limit
  assert.equal(await claim(db, 1), true); // 8 + 1 = 9
  await finish(db, 1);
  await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now()");
  assert.equal(await claim(db, 2), true); // 9 + 1 = 10.00, exactly the limit
  await finish(db, 2);
  assert.equal(await committed(db), 10);
  assert.equal(await claim(db, 3), false); // 10 + 1 > 10
  const blocked = await one(
    db,
    "SELECT detail FROM public.audit_logs WHERE action = 'code.task_blocked' ORDER BY ctid DESC LIMIT 1",
  );
  assert.equal(Number(blocked.detail.total_limit_usd), 10);
  assert.equal(
    (await one(db, "SELECT count(*)::int AS n FROM public.code_spend_reservations")).n,
    2,
  );
});

test("settled holds keep counting against the total (no refunds against the $10)", async () => {
  const db = await openDb();
  await request(db, 1);
  await db.query(
    `INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd, status, outcome, finished_at)
     VALUES ($1, 1001, 2, 'finished', 'success', now())`,
    [rid(1)],
  );
  await db.query(
    `UPDATE public.code_spend_reservations SET status = 'settled', settled_at = now(), released_usd = 2
     WHERE request_id = $1`,
    [rid(1)],
  );
  await usage(db, 1.5);
  assert.equal(await committed(db), 3.5);
});

test("a direct 'reserved' insert over the total is rejected whatever path inserts it", async () => {
  const db = await openDb();
  await usage(db, 9.5);
  await request(db, 1);
  await assert.rejects(
    db.query(
      "INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd) VALUES ($1, 1001, 1)",
      [rid(1)],
    ),
    /cumulative spending limit/,
  );
  assert.equal(
    (await one(db, "SELECT count(*)::int AS n FROM public.code_spend_reservations")).n,
    0,
  );
});

test("recorded spending over the total is kept and engages the Emergency Stop", async () => {
  const db = await openDb();
  await usage(db, 6);
  await usage(db, 4.01);
  const c = await controls(db);
  assert.equal(c.kill_switch, true);
  assert.equal(c.enabled, false);
  assert.match(c.paused_reason, /cumulative/);
  assert.equal(await audits(db, "code.total_spend_cap_pause"), 1);
  assert.equal(await committed(db), 10.01);
  assert.equal((await status(db)).exhausted, true);
});

test("a conservative finished hold over the total is recorded and stops CODE", async () => {
  const db = await openDb();
  await usage(db, 9.8);
  await request(db, 1);
  await db.query(
    `INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd, status, outcome, finished_at)
     VALUES ($1, 1001, 1, 'finished', 'failure', now())`,
    [rid(1)],
  );
  assert.equal((await controls(db)).kill_switch, true);
  assert.equal(await committed(db), 10.8);
});

test("provider calls are refused once the total is exceeded, even if someone clears the stop", async () => {
  const db = await openDb();
  assert.equal(await claim(db, 1), true);
  await usage(db, 9.5); // 1 hold + 9.5 = 10.5
  assert.equal((await controls(db)).kill_switch, true);
  await db.query("UPDATE public.code_runtime_controls SET kill_switch = false, enabled = true"); // test-only
  await assert.rejects(
    db.query("SELECT public.admit_code_provider_call($1, 1001, 'call00000001', 'gpt-6-luna', 0.25)", [
      rid(1),
    ]),
    /cumulative spending limit/,
  );
});

test("gateway overruns above a reservation are added to the total", async () => {
  const db = await openDb();
  assert.equal(await claim(db, 1), true);
  const { id } = await one(
    db,
    "SELECT public.admit_code_provider_call($1, 1001, 'call00000001', 'gpt-6-luna', 1) AS id",
    [rid(1)],
  );
  await db.query("SELECT public.dispatch_code_provider_call($1)", [id]);
  await db.query("SELECT public.settle_code_provider_call($1, 3, 'req_1')", [id]);
  assert.equal(await committed(db), 3); // 1 reserved + 2 overrun
  assert.equal((await controls(db)).kill_switch, true);
});

test("a disabled trigger or tampered function is detected and blocks claims", async () => {
  for (const tamper of [
    "ALTER TABLE public.code_usage_events DISABLE TRIGGER code_usage_events_total_guard",
    "ALTER TABLE public.code_spend_reservations DISABLE TRIGGER code_spend_reservations_total_guard",
    "DROP TRIGGER code_provider_calls_total_guard ON public.code_provider_calls",
    `CREATE OR REPLACE FUNCTION public.code_total_spend_committed() RETURNS numeric LANGUAGE sql STABLE
       SECURITY DEFINER SET search_path = '' AS $$ SELECT 0::numeric $$`,
  ]) {
    const db = await openDb();
    await usage(db, 0.5);
    await db.exec(tamper);
    const s = await status(db);
    assert.equal(s.enforced, false, tamper);
    assert.ok(s.missing.length > 0);
    assert.equal(await claim(db, 1), false, tamper);
  }
});

test("hard-cap flag: raw writes and non-owners refused; owner only while stopped and guarded", async () => {
  const db = await gated.clone();
  const c0 = await controls(db);
  assert.equal(c0.verified, false);
  await assert.rejects(
    db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
    /only be set by set_code_provider_hard_cap_verified/,
  );
  await assert.rejects(attest(db, true, stranger), /Only the owner/);
  await assert.rejects(
    db.query("SELECT public.set_code_provider_hard_cap_verified($1, true, 'short')", [owner]),
    /evidence/,
  );
  await db.query("UPDATE public.code_runtime_controls SET enabled = true, kill_switch = false");
  await assert.rejects(attest(db), /disabled and stopped/);
  await db.query("UPDATE public.code_runtime_controls SET enabled = false, kill_switch = true");
  await db.exec(
    "ALTER TABLE public.code_usage_events DISABLE TRIGGER code_usage_events_total_guard",
  );
  await assert.rejects(attest(db), /not enforced/);
  await db.exec("ALTER TABLE public.code_usage_events ENABLE TRIGGER code_usage_events_total_guard");
  await attest(db);
  const c1 = await controls(db);
  assert.equal(c1.verified, true);
  assert.equal(c1.enabled, false, "attesting never enables CODE");
  assert.equal(c1.kill_switch, true, "attesting never releases the Emergency Stop");
  assert.equal(await audits(db, "code.hard_cap_verified"), 1);
});

test("turning the flag off and engaging the stop always work, even with the guard broken", async () => {
  const db = await openDb();
  await db.exec("DROP TRIGGER code_usage_events_total_guard ON public.code_usage_events");
  await db.query(
    "UPDATE public.code_runtime_controls SET kill_switch = true, enabled = false, paused_reason = 'stop'",
  );
  assert.equal((await controls(db)).kill_switch, true);
  await db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = false");
  assert.equal((await controls(db)).verified, false);
  await attest(db, true).catch(() => {});
  assert.equal((await controls(db)).verified, false, "cannot re-verify while the guard is broken");
});

test("0048 refuses to install without 0047", async () => {
  const db = await chain.clone();
  await assert.rejects(db.exec(await proposed("0048_code_hard_cap_gate.sql")), /Apply 0047/);
  await assert.rejects(
    db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
    /check constraint/i,
  );
});

test("rollbacks restore the 0037 forced-false invariant and can be re-applied", async () => {
  const db = await openDb();
  await db.query("UPDATE public.code_runtime_controls SET enabled = false, kill_switch = true");
  await db.exec(await proposed("0048_code_hard_cap_gate.down.sql"));
  assert.equal((await controls(db)).verified, false);
  await assert.rejects(
    db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
    /check constraint/i,
  );
  await db.exec(await proposed("0047_code_total_spend_guard.down.sql"));
  const cols = await one(
    db,
    "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'code_runtime_controls' AND column_name = 'total_spend_limit_usd'",
  );
  assert.equal(cols.n, 0);
  await run(db);
  assert.equal(await claim(db, 1), false);
  await db.query("UPDATE public.code_runtime_controls SET enabled = false, kill_switch = true");
  await db.exec(await proposed("0047_code_total_spend_guard.sql"));
  await db.exec(await proposed("0048_code_hard_cap_gate.sql"));
  assert.equal((await status(db)).enforced, true);
});

test("0047 rollback refuses while the 0048 gate is installed", async () => {
  const db = await gated.clone();
  await assert.rejects(
    db.exec(await proposed("0047_code_total_spend_guard.down.sql")),
    /Roll back 0048/,
  );
});

test("pin update moves only the expected stopped pin, audits atomically and is idempotent", async () => {
  const sql = await proposed("0046_code_workflow_pin_37368194.sql");
  const db = await chain.clone();
  await db.exec(sql);
  const c = await controls(db);
  assert.deepEqual(c.allowed_targets, { [repo]: { ref: "main", workflowSha: newSha } });
  assert.equal(c.enabled, false);
  assert.equal(c.kill_switch, true);
  assert.equal(await audits(db, "code.workflow_pin_repair"), 1);
  assert.equal(
    (await one(db, "SELECT count(*)::int AS n FROM public.site_log WHERE action = 'code.workflow_pin_repair'")).n,
    1,
  );
  await db.exec(sql);
  assert.equal(await audits(db, "code.workflow_pin_repair"), 1, "re-run is a no-op");

  for (const setup of [
    "UPDATE public.code_runtime_controls SET enabled = true, kill_switch = false",
    `UPDATE public.code_runtime_controls SET allowed_targets = '{"other/repo":{"ref":"main","workflowSha":"${"b".repeat(40)}"}}'`,
  ]) {
    const refused = await chain.clone();
    await refused.exec(setup);
    await assert.rejects(refused.exec(sql), /refused/);
    assert.equal(await audits(refused, "code.workflow_pin_repair"), 0);
  }
});

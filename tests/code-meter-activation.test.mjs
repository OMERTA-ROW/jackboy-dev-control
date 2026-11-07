import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { supabaseStubs, migrationFiles } from "./helpers/staging-pg.mjs";

// In-memory PGlite only, synthetic IDs, no network, no provider calls. Replays the real applied
// migration chain (including the applied $10 guard and hard-cap gate), then the PROPOSED, UNAPPLIED
// staging/code-activation/0049 meter + activation gate.

const owner = "93a2e690-a179-4d08-bd68-a3a793fced11";
const stranger = "00000000-0000-4000-8000-000000000009";
const repo = "OMERTA-ROW/jackboy-dev-control";
const sha = "37368194f883bc1cf5175aecf4832945203b602b";
const rid = (n) => `00000000-0000-4000-8000-${String(200 + n).padStart(12, "0")}`;
const staged = (f) => readFile(`staging/code-activation/${f}`, "utf8");

let base; // applied chain + seed, production-like (CODE off, Stop on, global pause on)
let metered; // + staged 0049
const open = [];
const clone = async (db) => {
  const copy = await db.clone();
  open.push(copy);
  return copy;
};
after(async () => {
  for (const db of [...open, metered, base]) await db?.close().catch(() => {});
});

before(async () => {
  base = new PGlite();
  await base.exec(supabaseStubs);
  for (const f of await migrationFiles()) await base.exec(await readFile(`drizzle/migrations/${f}`, "utf8"));
  await base.query("INSERT INTO auth.users(id, email) VALUES ($1, 'o@x.test'), ($2, 's@x.test')", [owner, stranger]);
  await base.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [owner]);
  await base.query("UPDATE public.code_runtime_controls SET allowed_targets = $1::jsonb", [
    JSON.stringify({ [repo]: { ref: "main", workflowSha: sha } }),
  ]);
  await base.query("UPDATE public.automation_policy SET paused = true");
  metered = await clone(base);
  await metered.exec(await staged("0049_code_spend_meter_and_activation.sql"));
});

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const controls = async (db) => (await one(db, "SELECT to_jsonb(r) AS c FROM public.code_runtime_controls AS r")).c;
const meter = async (db) => (await one(db, "SELECT public.code_spend_meter_status() AS s")).s;
const refresh = async (db) => (await one(db, "SELECT public.refresh_code_spend_meter() AS s")).s;
const enable = async (db, actor = owner) => (await one(db, "SELECT public.enable_code_runtime($1) AS r", [actor])).r;
const audits = async (db, action) =>
  (await one(db, "SELECT count(*)::int AS n FROM public.audit_logs WHERE action = $1", [action])).n;

async function request(db, n) {
  await db.query(
    `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status,
       runner_claimed_at, runner_run_id, runner_run_attempt, resources)
     VALUES ($1, 'code', 'high', 'n', now() + interval '1 hour', $2, 'allowed', now(), $3, 1, $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [rid(n), owner, 2000 + n, JSON.stringify({ repo, ref: "main", workflowSha: sha })],
  );
}
const claim = async (db, n) => {
  await request(db, n);
  return (await one(db, "SELECT public.claim_code_runtime_slot($1, $2, 'main', $3, $4) AS ok", [rid(n), repo, sha, 2000 + n])).ok;
};
let ev = 0;
const usage = (db, usd, at = "now()") =>
  db.query(
    `INSERT INTO public.code_usage_events(provider_event_id, source, occurred_at, cost_usd)
     VALUES ($1, 'openai_org_costs', ${at}, $2)`,
    [`ev-${++ev}`, usd],
  );
const todayUsage = (db, usd) => usage(db, usd, "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
let ck = 0;
// Direct ledger rows (test database only) at a given age; dispatched/settled rows carry dispatched_at.
async function call(db, n, { status, ceiling, actual = null, age = "0 minutes", overrun = false }) {
  await request(db, n);
  const dispatched = status === "aborted" || status === "admitted" ? null : `now() - interval '${age}'`;
  const finished = status === "settled" || status === "aborted" ? `now() - interval '${age}'` : null;
  await db.query(
    `INSERT INTO public.code_provider_calls(request_id, run_id, call_key, model, ceiling_usd, status, actual_usd,
       overrun, created_at, dispatched_at, finished_at)
     VALUES ($1, $2, $3, 'gpt-6-luna', $4, $5, $6, $7, now() - interval '${age}', ${dispatched ?? "NULL"}, ${finished ?? "NULL"})`,
    [rid(n), 2000 + n, `callkey${String(++ck).padStart(4, "0")}`, ceiling, status, actual, overrun],
  );
}
const attest = (db) =>
  db.query("SELECT public.set_code_provider_hard_cap_verified($1, true, 'Owner checked the provider budget page')", [owner]);
// Every gate satisfied except the switch itself (test database only).
async function ready() {
  const db = await clone(metered);
  await attest(db);
  await db.query("UPDATE public.automation_policy SET paused = false");
  return db;
}

test("staged 0049 installs without turning anything on, and only the service role can call it", async () => {
  const c = await controls(metered);
  assert.equal(c.enabled, false);
  assert.equal(c.kill_switch, true);
  assert.equal(c.provider_usage_at, null);
  assert.equal(c.provider_hard_cap_verified, false);
  const s = await meter(metered);
  assert.equal(s.ok, true);
  assert.equal(Number(s.measured_today_usd), 0);
  const grants = await one(
    metered,
    `SELECT has_function_privilege('anon', 'public.enable_code_runtime(uuid)', 'EXECUTE') AS anon,
            has_function_privilege('authenticated', 'public.refresh_code_spend_meter()', 'EXECUTE') AS auth,
            has_function_privilege('authenticated', 'public.code_spend_meter_status()', 'EXECUTE') AS auth_status,
            has_function_privilege('service_role', 'public.enable_code_runtime(uuid)', 'EXECUTE') AS service`,
  );
  assert.deepEqual(grants, { anon: false, auth: false, auth_status: false, service: true });
});

test("staged 0049 refuses to install while CODE is on", async () => {
  const db = await clone(base);
  await db.query("UPDATE public.code_runtime_controls SET enabled = true, kill_switch = false");
  await assert.rejects(db.exec(await staged("0049_code_spend_meter_and_activation.sql")), /must be off/);
});

test("raw writes can never turn CODE on, release the stop, or stamp meter freshness", async () => {
  const db = await ready();
  await assert.rejects(db.query("UPDATE public.code_runtime_controls SET enabled = true"), /enable_code_runtime/);
  await assert.rejects(db.query("UPDATE public.code_runtime_controls SET kill_switch = false"), /enable_code_runtime/);
  await assert.rejects(db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now()"), /refresh_code_spend_meter/);
  await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = NULL"); // clearing is fine
  const c = await controls(db);
  assert.equal(c.enabled, false);
  assert.equal(c.kill_switch, true);
});

test("meter counts the gateway ledger at worst case plus open-task headroom, and takes the larger of gateway or OpenAI", async () => {
  const db = await clone(metered);
  await request(db, 1);
  await db.query(
    "INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd) VALUES ($1, 2001, 1)",
    [rid(1)],
  );
  await db.query(
    `INSERT INTO public.code_provider_calls(request_id, run_id, call_key, model, ceiling_usd, status, actual_usd, dispatched_at, finished_at)
     VALUES ($1, 2001, 'settledcall1', 'gpt-6-luna', 0.25, 'settled', 0.10, now(), now()),
            ($1, 2001, 'dispatchd01', 'gpt-6-luna', 0.30, 'dispatched', NULL, now(), NULL),
            ($1, 2001, 'abortedcl01', 'gpt-6-luna', 0.50, 'aborted', NULL, NULL, now())`,
    [rid(1)],
  );
  let s = await meter(db);
  // calls today: 0.10 settled + 0.30 dispatched ceiling + 0 aborted = 0.40; headroom 1 - 0.40 = 0.60
  assert.equal(Number(s.gateway_today_usd), 1);
  assert.equal(Number(s.provider_today_usd), 0);
  assert.equal(Number(s.measured_today_usd), 1);
  await todayUsage(db, 3);
  s = await meter(db);
  assert.equal(Number(s.measured_today_usd), 3, "a larger OpenAI report wins");
  assert.equal(s.ok, true);
});

test("meter refuses when today's measured spend plus one task would pass the daily limit, and refresh then clears freshness", async () => {
  const db = await clone(metered);
  let s = await refresh(db);
  assert.equal(s.ok, true);
  assert.notEqual((await controls(db)).provider_usage_at, null);
  await todayUsage(db, 4.01); // 4.01 + 1.00 > 5.00
  s = await refresh(db);
  assert.equal(s.ok, false);
  assert.ok(s.reasons.includes("daily_limit"));
  assert.equal((await controls(db)).provider_usage_at, null);
  assert.equal(await audits(db, "code.spend_meter_blocked"), 1);
  const exact = await clone(metered);
  await todayUsage(exact, 4); // 4 + 1 = 5.00 fits exactly
  assert.equal((await meter(exact)).ok, true);
});

test("meter refuses on a gateway spending spike, a recent overrun, or a tampered $10 guard", async () => {
  const spike = await clone(metered);
  await call(spike, 1, { status: "settled", ceiling: 2.5, actual: 2.5, age: "10 minutes" });
  assert.deepEqual((await meter(spike)).reasons, ["hourly_spike"]);

  const overrun = await clone(metered);
  await call(overrun, 1, { status: "settled", ceiling: 0.1, actual: 0.2, overrun: true, age: "2 hours" });
  assert.ok((await meter(overrun)).reasons.includes("recent_overrun"));

  const tampered = await clone(metered);
  await tampered.query("ALTER TABLE public.code_usage_events DISABLE TRIGGER code_usage_events_total_guard");
  assert.ok((await meter(tampered)).reasons.includes("total_guard"));
});

test("OpenAI cross-check: closed days with gateway calls need a closed-day report that matches the gateway", async () => {
  const db = await clone(metered);
  await call(db, 1, { status: "settled", ceiling: 0.5, actual: 0.2, age: "3 days" });
  await call(db, 2, { status: "settled", ceiling: 0.5, actual: 0.2, age: "1 day" }); // yesterday: not yet required
  let s = await meter(db);
  assert.deepEqual(s.reasons, ["unreported_days"]);
  assert.equal(s.unreported_days.length, 1);
  const day = s.unreported_days[0];
  await db.query(
    `INSERT INTO public.code_provider_cost_day_reports(utc_day, synced_at, reported_cost_usd, bucket_count, recorded_by)
     VALUES ($1::date, (($1::date + 1)::timestamp AT TIME ZONE 'UTC') + interval '7 hours', 0.2, 1, $2)`,
    [day, owner],
  );
  await usage(db, 0.2, `($$${day}$$::date)::timestamp AT TIME ZONE 'UTC'`);
  s = await meter(db);
  assert.equal(s.ok, true, JSON.stringify(s.reasons));

  await usage(db, 0.3, `($$${day}$$::date)::timestamp AT TIME ZONE 'UTC'`); // OpenAI saw $0.50, gateway admitted $0.20
  s = await meter(db);
  assert.ok(s.reasons.includes("bypass_suspected"));
  assert.deepEqual(s.bypass_days, [day]);
});

test("the owner switch refuses every failing gate, records why, and never changes CODE", async () => {
  const cases = [
    ["hard_cap_unverified", async () => { const db = await clone(metered); await db.query("UPDATE public.automation_policy SET paused = false"); return db; }],
    ["global_pause", async () => { const db = await ready(); await db.query("UPDATE public.automation_policy SET paused = true"); return db; }],
    ["active_task", async () => { const db = await ready(); await request(db, 9); await db.query("UPDATE public.code_runtime_controls SET active_request_id = $1", [rid(9)]); return db; }],
    ["failure_stop", async () => { const db = await ready(); await db.query("UPDATE public.code_runtime_controls SET consecutive_failures = 2"); return db; }],
    ["usage_spike", async () => { const db = await ready(); await db.query("UPDATE public.code_runtime_controls SET usage_spike = true"); return db; }],
    ["cancellation_unconfirmed", async () => { const db = await ready(); await db.query("UPDATE public.code_runtime_controls SET cancellation_status = 'pending'"); return db; }],
    ["total_limit", async () => { const db = await ready(); await usage(db, 9.5, "now() - interval '3 days'"); return db; }],
    ["spend_meter", async () => { const db = await ready(); await todayUsage(db, 4.5); return db; }],
    ["target_allowlist", async () => {
      const db = await ready();
      await db.query("UPDATE public.code_runtime_controls SET allowed_targets = $1::jsonb", [
        JSON.stringify({ [repo]: { ref: "main", workflowSha: sha }, "OMERTA-ROW/other": { ref: "main", workflowSha: sha } }),
      ]);
      return db;
    }],
    ["target_allowlist", async () => {
      const db = await ready();
      await db.query("UPDATE public.code_runtime_controls SET allowed_targets = $1::jsonb", [JSON.stringify({ [repo]: { ref: "dev", workflowSha: sha } })]);
      return db;
    }],
  ];
  for (const [reason, setup] of cases) {
    const db = await setup();
    const r = await enable(db);
    assert.equal(r.ok, false, reason);
    assert.ok(r.reasons.includes(reason), `${reason}: got ${JSON.stringify(r.reasons)}`);
    const c = await controls(db);
    assert.equal(c.enabled, false, reason);
    assert.equal(c.kill_switch, true, reason);
    assert.equal(await audits(db, "code.runtime_enable_refused"), 1, reason);
    assert.equal(await audits(db, "code.runtime_enabled"), 0, reason);
  }
  await assert.rejects(enable(await ready(), stranger), /Only the owner/);
});

test("when every gate passes the owner switch turns CODE on, clears the stale stop marker, and can be stopped again", async () => {
  const db = await ready();
  await db.query("SELECT public.engage_code_kill_switch($1)", [owner]); // leaves stop_requested_at set
  assert.notEqual((await controls(db)).stop_requested_at, null);
  const r = await enable(db);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  const c = await controls(db);
  assert.equal(c.enabled, true);
  assert.equal(c.kill_switch, false);
  assert.equal(c.stop_requested_at, null);
  assert.equal(c.cancellation_status, "not_needed");
  assert.equal(c.paused_reason, null);
  assert.equal(await audits(db, "code.runtime_enabled"), 1);
  const again = await enable(db);
  assert.equal(again.ok, false);
  assert.ok(again.reasons.includes("not_stopped"));
  await db.query("SELECT public.engage_code_kill_switch($1)", [owner]); // stopping is never blocked
  assert.equal((await controls(db)).kill_switch, true);
  await assert.rejects(db.query("UPDATE public.code_runtime_controls SET kill_switch = false"), /enable_code_runtime/);
});

test("end to end (test database): a task starts only after enable AND a fresh meter, and its provider calls are admitted", async () => {
  const db = await ready();
  await db.query("SELECT public.engage_code_kill_switch($1)", [owner]);
  assert.equal((await enable(db)).ok, true);
  assert.equal(await claim(db, 1), false, "no meter stamp yet");
  assert.equal((await refresh(db)).ok, true);
  assert.equal(await claim(db, 1), true);
  const admitted = await one(db, "SELECT public.admit_code_provider_call($1, 2001, 'firstcall01', 'gpt-6-luna', 0.5) AS id", [rid(1)]);
  assert.ok(admitted.id, "provider calls are admitted once the stale stop marker is cleared");
  await db.query("SELECT public.finish_code_runtime_slot($1, 2001, 1, 'success')", [rid(1)]);

  // A stale stamp (written as the meter would have, 6 minutes ago) blocks the next claim.
  await db.query("BEGIN");
  await db.query("SELECT set_config('jackboy.code_meter', 'refresh', true)");
  await db.query("UPDATE public.code_runtime_controls SET provider_usage_at = now() - interval '6 minutes'");
  await db.query("COMMIT");
  assert.equal(await claim(db, 2), false);
});

test("rollback turns CODE off, removes the meter and gate, and claims refuse again", async () => {
  const db = await ready();
  assert.equal((await enable(db)).ok, true);
  await db.exec(await staged("0049_code_spend_meter_and_activation.down.sql"));
  const c = await controls(db);
  assert.equal(c.enabled, false);
  assert.equal(c.kill_switch, true);
  assert.equal(c.provider_usage_at, null);
  assert.equal("spend_meter" in c, false);
  const gone = await one(db, "SELECT to_regprocedure('public.enable_code_runtime(uuid)') AS f");
  assert.equal(gone.f, null);
});

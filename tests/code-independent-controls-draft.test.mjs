// Real PostgreSQL engine (PGlite) over the full migration chain (which matches production's CODE
// functions byte-for-byte). Tests the DRAFT that makes the System Kill Switch, the CODE enabled setting
// and the CODE Emergency Stop independent. Installed on production 2026-11-13 as
// 0065_code_independent_controls (history row 72), byte-identical to the reviewed script.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrationFiles, supabaseStubs } from "./helpers/staging-pg.mjs";

const DRAFT = "scripts/code-independent-controls-draft.sql";
const owner = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const repo = "OMERTA-ROW/jackboy-dev-control";
const sha = "a".repeat(40);
const INSTALLED = "0065_code_independent_controls.sql";
let chain; // production chain as it was before 0065 was installed
let base; // chain + 0065
let db; // fresh clone of base for each test
const draft = await readFile(DRAFT, "utf8");

const fnDef = async (d, name) =>
  (
    await d.query(
      "SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1",
      [name],
    )
  ).rows[0]?.d;
const one = async (d, sql, params) => (await d.query(sql, params)).rows[0];
const state = (d) =>
  one(
    d,
    "SELECT c.enabled, c.kill_switch AS stop, (SELECT paused FROM public.automation_policy WHERE id=1) AS paused FROM public.code_runtime_controls c",
  );
const audits = async (d) =>
  (await d.query("SELECT action, outcome, detail FROM public.audit_logs ORDER BY ctid")).rows;

// Seeds a CODE row whose readiness checks all pass, with the three controls set as given. Seeding writes
// bypass the triggers (fixture only); every action under test runs with the triggers on.
async function seed(d, { enabled = false, stop = true, paused = true, ...extra } = {}) {
  await d.exec("ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER");
  await d.query(
    `UPDATE public.code_runtime_controls SET enabled=$1, kill_switch=$2, allowed_targets=$3::jsonb,
       provider_hard_cap_verified=true, active_request_id=NULL, active_run_id=NULL, consecutive_failures=$4,
       usage_spike=$5, cancellation_status=$6, provider_usage_at=now(), stop_requested_at=NULL, paused_reason=NULL`,
    [
      enabled,
      stop,
      JSON.stringify({ [repo]: { ref: "main", workflowSha: sha } }),
      extra.failures ?? 0,
      extra.spike ?? false,
      extra.cancellation ?? "not_needed",
    ],
  );
  await d.exec("ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER");
  await d.query("UPDATE public.automation_policy SET paused=$1 WHERE id=1", [paused]);
}

before(async () => {
  chain = new PGlite();
  await chain.exec(supabaseStubs);
  for (const f of await migrationFiles()) {
    if (f >= INSTALLED) break;
    await chain.exec(await readFile(`drizzle/migrations/${f}`, "utf8"));
  }
  await chain.query("INSERT INTO auth.users(id,email) VALUES ($1,'o@x.test'),($2,'m@x.test')", [
    owner,
    member,
  ]);
  await chain.query(
    "INSERT INTO public.user_roles(user_id, role) VALUES ($1,'owner'),($2,'member')",
    [owner, member],
  );
  await chain.exec(
    "INSERT INTO public.automation_policy(id, paused) VALUES (1, true) ON CONFLICT (id) DO NOTHING",
  );
  base = await chain.clone();
  await base.exec(await readFile(`drizzle/migrations/${INSTALLED}`, "utf8"));
});
after(async () => {
  await db?.close();
  await base?.close();
  await chain?.close();
});
beforeEach(async () => {
  await db?.close();
  db = await base.clone();
  await seed(db);
});

const setEnabled = (on, actor = owner) =>
  one(db, "SELECT public.set_code_enabled($1,$2) AS r", [actor, on]).then((x) => x.r);
const engage = (actor = owner) =>
  db.query("SELECT * FROM public.engage_code_kill_switch($1)", [actor]);
const release = (actor = owner) =>
  one(db, "SELECT public.release_code_emergency_stop($1) AS r", [actor]).then((x) => x.r);
const setKill = (paused) =>
  db.query("UPDATE public.automation_policy SET paused=$1 WHERE id=1", [paused]);

test("before the draft, production still couples the controls (documents the bug)", async () => {
  await seed(chain, { enabled: true, stop: false, paused: false });
  await chain.query("SELECT * FROM public.engage_code_kill_switch($1)", [owner]);
  assert.deepEqual(
    await state(chain),
    { enabled: false, stop: true, paused: false },
    "old stop also turned CODE off",
  );
  assert.equal(
    (await one(chain, "SELECT to_regprocedure('public.set_code_enabled(uuid,boolean)') AS f")).f,
    null,
  );
});

test("CODE ON changes only the CODE setting: Kill Switch and Emergency Stop stay as they were", async () => {
  for (const [stop, paused] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]) {
    await seed(db, { enabled: false, stop, paused });
    const r = await setEnabled(true);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(
      await state(db),
      { enabled: true, stop, paused },
      `stop=${stop} paused=${paused}`,
    );
    const last = (await audits(db)).at(-1);
    assert.equal(last.action, "code.enabled_on");
    assert.equal(last.detail.emergency_stop_unchanged, stop);
  }
});

test("CODE OFF changes only the CODE setting", async () => {
  for (const [stop, paused] of [
    [true, true],
    [false, false],
    [false, true],
    [true, false],
  ]) {
    await seed(db, { enabled: true, stop, paused });
    assert.equal((await setEnabled(false)).ok, true);
    assert.deepEqual(await state(db), { enabled: false, stop, paused });
    assert.equal((await audits(db)).at(-1).action, "code.enabled_off");
  }
});

test("Emergency Stop engage changes only the stop and keeps the saved CODE setting", async () => {
  for (const [enabled, paused] of [
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ]) {
    await seed(db, { enabled, stop: false, paused });
    await engage();
    assert.deepEqual(await state(db), { enabled, stop: true, paused });
    const last = (await audits(db)).at(-1);
    assert.equal(last.action, "code.emergency_stop");
    assert.equal(last.detail.code_enabled_unchanged, enabled);
  }
});

test("Emergency Stop can be engaged while CODE is disabled and while the Kill Switch is on", async () => {
  await seed(db, { enabled: false, stop: false, paused: true });
  await engage();
  assert.deepEqual(await state(db), { enabled: false, stop: true, paused: true });
});

test("Emergency Stop release changes only the stop", async () => {
  for (const [enabled, paused] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ]) {
    await seed(db, { enabled, stop: true, paused });
    const r = await release();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await state(db), { enabled, stop: false, paused });
    assert.equal((await audits(db)).at(-1).action, "code.emergency_stop_released");
  }
});

test("Kill Switch writes never touch the CODE row", async () => {
  await seed(db, { enabled: true, stop: false, paused: false });
  await setKill(true);
  assert.deepEqual(await state(db), { enabled: true, stop: false, paused: true });
  await setKill(false);
  assert.deepEqual(await state(db), { enabled: true, stop: false, paused: false });
});

test("release is refused (audited, nothing changed) while any emergency protection holds", async () => {
  const cases = [
    [{ failures: 2 }, "failure_stop"],
    [{ spike: true }, "usage_spike"],
    [{ cancellation: "pending" }, "cancellation_unconfirmed"],
  ];
  for (const [extra, reason] of cases) {
    await seed(db, { enabled: true, stop: true, paused: false, ...extra });
    const r = await release();
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes(reason), JSON.stringify(r));
    assert.deepEqual(await state(db), { enabled: true, stop: true, paused: false });
    assert.equal((await audits(db)).at(-1).action, "code.emergency_stop_release_refused");
  }
  await seed(db, { stop: true });
  await db.exec(
    "ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER; UPDATE public.code_runtime_controls SET provider_hard_cap_verified=false; ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER",
  );
  assert.ok((await release()).reasons.includes("hard_cap_unverified"));
  assert.equal((await state(db)).stop, true);
});

test("CODE ON keeps every authorisation, allowlist, metering and budget check (fail closed)", async () => {
  await seed(db, { failures: 2 });
  assert.ok((await setEnabled(true)).reasons.includes("failure_stop"));
  await seed(db);
  await db.exec(
    "ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER; UPDATE public.code_runtime_controls SET allowed_targets='{}'::jsonb; ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER",
  );
  assert.ok((await setEnabled(true)).reasons.includes("target_allowlist"));
  await seed(db);
  await db.exec(
    "ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER; UPDATE public.code_runtime_controls SET provider_hard_cap_verified=false; ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER",
  );
  assert.ok((await setEnabled(true)).reasons.includes("hard_cap_unverified"));
  await seed(db);
  // Fill the $10 total so one more $1 task cannot fit.
  await db.query(
    "INSERT INTO public.code_usage_events(provider_event_id, source, occurred_at, cost_usd) VALUES ('evt-full', 'openai_org_costs', now() - interval '3 days', 9.50)",
  );
  const r = await setEnabled(true);
  assert.equal(r.ok, false);
  assert.ok(
    r.reasons.some((x) => ["total_limit", "total_guard", "spend_meter"].includes(x)),
    JSON.stringify(r),
  );
  assert.equal((await state(db)).enabled, false);
  assert.equal((await audits(db)).at(-1).action, "code.enable_refused");
});

test("only the owner can use any of the three CODE actions", async () => {
  await assert.rejects(setEnabled(true, member), /Only the owner/);
  await assert.rejects(setEnabled(false, member), /Only the owner/);
  await assert.rejects(release(member), /Only the owner/);
  await assert.rejects(engage(member), /Only the owner/);
  await assert.rejects(setEnabled(true, null), /Only the owner/);
  assert.deepEqual(await state(db), { enabled: false, stop: true, paused: true });
});

test("direct writes still cannot turn CODE on or release the stop", async () => {
  await assert.rejects(
    db.exec("UPDATE public.code_runtime_controls SET enabled=true"),
    /set_code_enabled/,
  );
  await assert.rejects(
    db.exec("UPDATE public.code_runtime_controls SET kill_switch=false"),
    /release_code_emergency_stop/,
  );
});

test("the old combined path no longer releases the stop", async () => {
  await seed(db, { enabled: false, stop: true, paused: false });
  const r = (await one(db, "SELECT public.enable_code_runtime($1) AS r", [owner])).r;
  assert.equal(r.ok, true);
  assert.deepEqual(await state(db), { enabled: true, stop: true, paused: false });
});

// Execution eligibility: CODE admission refuses unless Kill Switch off AND stop released AND CODE enabled.
let runSeq = 100;
async function claim(combo) {
  await seed(db, combo);
  const id = crypto.randomUUID();
  const run = ++runSeq;
  await db.query(
    `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt, resources)
     VALUES ($1,'code_workflow','high','n', now()+interval '1 hour', $2, 'allowed', now(), $4, 1, $3::jsonb)`,
    [id, owner, JSON.stringify({ repo, ref: "main", workflowSha: sha }), run],
  );
  // Freshness stamp only via the meter (as production).
  await db.exec("SELECT public.refresh_code_spend_meter()");
  const ok = (
    await one(db, "SELECT public.claim_code_runtime_slot($1,$2,'main',$3,$4) AS ok", [
      id,
      repo,
      sha,
      run,
    ])
  ).ok;
  return { ok, id, run };
}

test("all 8 control combinations: CODE can start only when all three allow it", async () => {
  for (const paused of [true, false])
    for (const stop of [true, false])
      for (const enabled of [true, false]) {
        const { ok } = await claim({ enabled, stop, paused });
        assert.equal(
          ok,
          !paused && !stop && enabled,
          `paused=${paused} stop=${stop} enabled=${enabled}`,
        );
      }
});

test("Kill Switch blocks AI-call admission and dispatch mid-task without touching CODE settings", async () => {
  const { ok, id, run } = await claim({ enabled: true, stop: false, paused: false });
  assert.equal(ok, true);
  const callId = (
    await one(db, "SELECT public.admit_code_provider_call($1,$2,'callkey01','m-test',0.10) AS id", [
      id,
      run,
    ])
  ).id;
  await setKill(true);
  await assert.rejects(
    db.query("SELECT public.admit_code_provider_call($1,$2,'callkey02','m-test',0.10)", [id, run]),
    /blocked/,
  );
  await assert.rejects(
    db.query("SELECT public.dispatch_code_provider_call($1)", [callId]),
    /blocked/,
  );
  assert.deepEqual(await state(db), { enabled: true, stop: false, paused: true });
  await setKill(false);
  await db.query("SELECT public.dispatch_code_provider_call($1)", [callId]);
});

test("a missing Kill Switch row fails closed", async () => {
  await seed(db, { enabled: true, stop: false, paused: false });
  await db.exec("DELETE FROM public.automation_policy");
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt, resources)
     VALUES ($1,'code_workflow','high','n', now()+interval '1 hour', $2, 'allowed', now(), 7, 1, $3::jsonb)`,
    [id, owner, JSON.stringify({ repo, ref: "main", workflowSha: sha })],
  );
  await db.exec("SELECT public.refresh_code_spend_meter()");
  assert.equal(
    (
      await one(db, "SELECT public.claim_code_runtime_slot($1,$2,'main',$3,7) AS ok", [
        id,
        repo,
        sha,
      ])
    ).ok,
    false,
  );
  await db.exec("INSERT INTO public.automation_policy(id, paused) VALUES (1, true)");
});

test("admission functions differ from production by exactly the one Kill Switch line, caps intact", async () => {
  const added =
    "    OR NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false)\n";
  for (const name of [
    "claim_code_runtime_slot",
    "admit_code_provider_call",
    "dispatch_code_provider_call",
  ]) {
    const before = await fnDef(chain, name);
    const after = await fnDef(db, name);
    assert.equal(after.replace(added, ""), before, name);
    assert.equal(after.split(added).length, 2, `${name} has the line once`);
  }
  assert.equal((await one(db, "SELECT public.code_total_spend_guard_enforced() AS ok")).ok, true);
  assert.equal(
    (await one(db, "SELECT public.code_independent_controls_installed() AS ok")).ok,
    true,
  );
  assert.equal(
    (
      await one(
        chain,
        "SELECT to_regprocedure('public.code_independent_controls_installed()') AS f",
      )
    ).f,
    null,
  );
  const c = await one(
    db,
    "SELECT per_task_reserve_usd::text r, daily_spend_limit_usd::text d, total_spend_limit_usd::text t FROM public.code_runtime_controls",
  );
  assert.deepEqual(c, { r: "1.00", d: "5.00", t: "10.00" });
});

test("new functions are service-role only", async () => {
  for (const fn of [
    "set_code_enabled(uuid,boolean)",
    "release_code_emergency_stop(uuid)",
    "code_independent_controls_installed()",
    "engage_code_kill_switch(uuid)",
    "enable_code_runtime(uuid)",
  ]) {
    for (const role of ["anon", "authenticated"]) {
      const { ok } = await one(db, "SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [
        role,
        `public.${fn}`,
      ]);
      assert.equal(ok, false, `${role} on ${fn}`);
    }
    assert.equal(
      (
        await one(db, "SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [
          `public.${fn}`,
        ])
      ).ok,
      true,
    );
  }
});

test("installed 0065 is byte-identical to the reviewed script, journaled once, and never writes the Kill Switch", async () => {
  const installed = await readFile(`drizzle/migrations/${INSTALLED}`, "utf8");
  assert.equal(installed, draft);
  const { entries } = JSON.parse(await readFile("drizzle/migrations/meta/_journal.json", "utf8"));
  assert.equal(entries.filter((e) => e.tag === "0065_code_independent_controls").length, 1);
  assert.ok(!/UPDATE\s+public\.automation_policy/i.test(draft));
});

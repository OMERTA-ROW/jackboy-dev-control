// Isolated PGlite proof for 0074_code_kill_switch_marker (no production database is touched).
// 0070 kept the System Kill Switch refusal in the three CODE admission functions but compacted its
// whitespace, so 0065's exact-text detector code_independent_controls_installed() reports false.
// 0074 re-creates 0070's definitions and adds only the 0065-spelled line.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrationFiles, supabaseStubs } from "./helpers/staging-pg.mjs";

const FILE = "0074_code_kill_switch_marker.sql";
const sql = await readFile(`drizzle/migrations/${FILE}`, "utf8");
const owner = "11111111-1111-4111-8111-111111111111";
const repo = "OMERTA-ROW/jackboy-dev-control";
const sha = "a".repeat(40);
const FNS = ["claim_code_runtime_slot", "admit_code_provider_call", "dispatch_code_provider_call"];
const ADDED =
  "    OR NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false)\n";
const COMPACT =
  "    OR NOT EXISTS(SELECT 1 FROM public.automation_policy WHERE id=1 AND paused=false)\n";

let chain; // every migration before 0074 (production's 0070+ definitions)
let after74; // chain + 0074
const one = async (d, q, p) => (await d.query(q, p)).rows[0];
const detector = async (d) =>
  (await one(d, "SELECT public.code_independent_controls_installed() AS ok")).ok;
const meta = async (d, name) =>
  one(
    d,
    `SELECT pg_get_functiondef(p.oid) AS def, p.prosrc AS src, p.proacl::text AS acl,
            pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS config,
            pg_get_function_identity_arguments(p.oid) AS args, p.prorettype::regtype::text AS ret
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=$1`,
    [name],
  );
const tableRows = async (d) => {
  const out = {};
  for (const { t } of (
    await d.query("SELECT tablename AS t FROM pg_tables WHERE schemaname='public' ORDER BY 1")
  ).rows)
    out[t] = (await one(d, `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM public."${t}" x`)).h;
  return out;
};

async function seed(d, { enabled, stop, paused }) {
  await d.exec("ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER");
  await d.query(
    `UPDATE public.code_runtime_controls SET enabled=$1, kill_switch=$2, allowed_targets=$3::jsonb,
       provider_hard_cap_verified=true, active_request_id=NULL, active_run_id=NULL, consecutive_failures=0,
       usage_spike=false, cancellation_status='not_needed', provider_usage_at=now(), stop_requested_at=NULL`,
    [enabled, stop, JSON.stringify({ [repo]: { ref: "main", workflowSha: sha } })],
  );
  await d.exec("ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER");
  await d.query("UPDATE public.automation_policy SET paused=$1 WHERE id=1", [paused]);
}
let runSeq = 100;
async function claim(base, combo) {
  const d = await base.clone();
  await seed(d, combo);
  const id = crypto.randomUUID();
  const run = ++runSeq;
  await d.query(
    `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt, resources)
     VALUES ($1,'code_workflow','high','n', now()+interval '1 hour', $2, 'allowed', now(), $4, 1, $3::jsonb)`,
    [id, owner, JSON.stringify({ repo, ref: "main", workflowSha: sha }), run],
  );
  await d.exec("SELECT public.refresh_code_spend_meter()");
  const ok = (
    await one(d, "SELECT public.claim_code_runtime_slot($1,$2,'main',$3,$4) AS ok", [id, repo, sha, run])
  ).ok;
  return { d, ok, id, run };
}

before(async () => {
  chain = new PGlite();
  await chain.exec(supabaseStubs);
  for (const f of await migrationFiles()) {
    if (f >= FILE) break;
    await chain.exec(await readFile(`drizzle/migrations/${f}`, "utf8"));
  }
  await chain.query("INSERT INTO auth.users(id,email) VALUES ($1,'o@x.test')", [owner]);
  await chain.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1,'owner')", [owner]);
  await chain.exec(
    "INSERT INTO public.automation_policy(id, paused) VALUES (1, true) ON CONFLICT (id) DO NOTHING",
  );
  after74 = await chain.clone();
  await after74.exec(sql);
});
after(async () => {
  await after74?.close();
  await chain?.close();
});

test("before 0074 the detector is false although every function holds the compact Kill Switch line", async () => {
  assert.equal(await detector(chain), false);
  for (const name of FNS) {
    const { src } = await meta(chain, name);
    assert.ok(src.includes(COMPACT), `${name} keeps 0070's compact refusal`);
    assert.ok(!src.includes(ADDED), `${name} lacks the 0065 spelling`);
  }
});

test("after 0074 the detector is true", async () => {
  assert.equal(await detector(after74), true);
});

test("each function equals 0070's definition plus exactly the one 0065 line, metadata and grants unchanged", async () => {
  for (const name of FNS) {
    const b = await meta(chain, name);
    const a = await meta(after74, name);
    assert.equal(a.def.split(ADDED).length, 2, `${name} has the added line once`);
    assert.equal(a.def.replace(ADDED, ""), b.def, `${name} changed beyond the one line`);
    assert.ok(a.src.includes(COMPACT + ADDED), `${name} keeps the compact line directly above`);
    assert.ok(a.src.includes("PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE"), `${name} keeps 0070's lock`);
    for (const k of ["acl", "owner", "prosecdef", "config", "args", "ret"])
      assert.equal(a[k], b[k], `${name} ${k}`);
  }
});

test("0074 writes no table rows", async () => {
  const d = await chain.clone();
  const beforeRows = await tableRows(d);
  await d.exec(sql);
  assert.deepEqual(await tableRows(d), beforeRows);
  await d.close();
});

test("CODE start refusal is the same before and after 0074 for all 8 control combinations", async () => {
  for (const paused of [true, false])
    for (const stop of [true, false])
      for (const enabled of [true, false]) {
        const want = !paused && !stop && enabled;
        for (const [label, base] of [["0073", chain], ["0074", after74]]) {
          const { d, ok } = await claim(base, { enabled, stop, paused });
          assert.equal(ok, want, `${label} paused=${paused} stop=${stop} enabled=${enabled}`);
          await d.close();
        }
      }
});

test("after 0074 the Kill Switch still blocks AI-call admission and dispatch mid-task", async () => {
  const { d, ok, id, run } = await claim(after74, { enabled: true, stop: false, paused: false });
  assert.equal(ok, true);
  const callId = (
    await one(d, "SELECT public.admit_code_provider_call($1,$2,'callkey01','m-test',0.10) AS id", [id, run])
  ).id;
  await d.query("UPDATE public.automation_policy SET paused=true WHERE id=1");
  await assert.rejects(
    d.query("SELECT public.admit_code_provider_call($1,$2,'callkey02','m-test',0.10)", [id, run]),
    /blocked/,
  );
  await assert.rejects(d.query("SELECT public.dispatch_code_provider_call($1)", [callId]), /blocked/);
  await d.query("UPDATE public.automation_policy SET paused=false WHERE id=1");
  await d.query("SELECT public.dispatch_code_provider_call($1)", [callId]);
  await d.close();
});

test("the closing check rolls 0074 back if a function is missing the line", async () => {
  const d = await chain.clone();
  const broken = sql.replace(COMPACT + ADDED, COMPACT); // drop it from the first function only
  assert.notEqual(broken, sql);
  await assert.rejects(d.exec(broken), /still reports false/);
  assert.equal(await detector(d), false);
  const { def } = await meta(d, "admit_code_provider_call");
  assert.ok(!def.includes(ADDED), "nothing from the failed run was kept");
  await d.close();
});

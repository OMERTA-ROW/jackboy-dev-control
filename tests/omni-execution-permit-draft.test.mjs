// Real PostgreSQL engine (PGlite) over the full migration chain plus the DRAFT
// scripts/omni-execution-permit-draft.sql (not journaled, not installed on production).
// Jackboy is the final permission and Emergency Stop gate for OMNI autonomous/CODE execution.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrationFiles, supabaseStubs } from "./helpers/staging-pg.mjs";

const DRAFT = "scripts/omni-execution-permit-draft.sql";
const owner = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const project = "33333333-3333-4333-8333-333333333333";
const approval = "44444444-4444-4444-8444-444444444444";
const proofJob = "55555555-5555-4555-8555-555555555555";
const jobA = "66666666-6666-4666-8666-666666666666";
const jobB = "77777777-7777-4777-8777-777777777777";
const client = "OMNI";
const tokenHash = "a".repeat(64);
const dig = "b".repeat(64);
let base;
let db;
let nonceN = 0;

const one = async (d, sql, params) => (await d.query(sql, params)).rows[0];

async function seedControls(d, { enabled = true, stop = false, paused = false } = {}) {
  await d.exec("ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER");
  await d.query("UPDATE public.code_runtime_controls SET enabled=$1, kill_switch=$2", [enabled, stop]);
  await d.exec("ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER");
  await d.exec("ALTER TABLE public.automation_policy DISABLE TRIGGER USER");
  await d.query("UPDATE public.automation_policy SET paused=$1 WHERE id=1", [paused]);
  await d.exec("ALTER TABLE public.automation_policy ENABLE TRIGGER USER");
}

before(async () => {
  base = new PGlite();
  await base.exec(supabaseStubs);
  for (const f of await migrationFiles()) await base.exec(await readFile(`drizzle/migrations/${f}`, "utf8"));
  await base.exec(await readFile(DRAFT, "utf8"));
  await base.query("INSERT INTO auth.users(id,email) VALUES ($1,'o@x.test'),($2,'m@x.test')", [owner, member]);
  await base.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1,'owner'),($2,'member')", [owner, member]);
  await base.exec("INSERT INTO public.automation_policy(id, paused) VALUES (1, false) ON CONFLICT (id) DO NOTHING");
  await base.query("INSERT INTO public.owner_projects(id,name,created_by) VALUES ($1,'OMNI',$2)", [project, owner]);
  await base.query("INSERT INTO public.omni_link_approval(id,approval_id,expires_at,saved_by,saved_at) VALUES (1,$1,now()+interval '20 hours',$2,now()-interval '1 hour')", [approval, owner]);
  await base.query(
    `INSERT INTO public.omni_inbound_jobs(id,client_id,project_id,approval_id,kind,status,deadline,updated_at,result)
     VALUES ($1,$2,$3,$4,'protocol.self-test','completed',now(),now()-interval '10 minutes',
       '{"passed":true,"checks":3,"runner":"restricted-protocol-self-test"}')`,
    [proofJob, client, project, approval],
  );
  await base.query("INSERT INTO public.omni_link_sessions VALUES ($1,$2,$3,$4,now()+interval '4 minutes')", [tokenHash, client, project, approval]);
  await base.query("INSERT INTO public.owner_passkeys(user_id,credential_id,public_key) VALUES ($1,'cred-1','pk')", [owner]);
});
after(async () => {
  await db?.close();
  await base?.close();
});
beforeEach(async () => {
  await db?.close();
  db = await base.clone();
  await seedControls(db);
});

async function grant(d = db, { target = `omni-autonomy:${approval}`, cred = "cred-1", user = owner } = {}) {
  return (await one(d, "INSERT INTO public.step_up_grants(user_id,action,target,credential_id,expires_at) VALUES ($1,'omni_autonomy',$2,$3,now()+interval '5 minutes') RETURNING id", [user, target, cred])).id;
}
const authorize = async (step, { actor = owner, runner = true } = {}) =>
  (await one(db, "SELECT public.omni_autonomy_authorization_action('authorize',$1,$2,$3,$4,$5,NULL) AS r", [actor, client, project, step, runner])).r;
const revokeAuth = async () => (await one(db, "SELECT public.omni_autonomy_authorization_action('revoke',$1,$2,$3,NULL,NULL,'test') AS r", [owner, client, project])).r;
const args = (extra = {}) => ({
  clientId: client, projectId: project, approvalId: approval, ownerId: owner,
  approvalExpiresAt: new Date(Date.now() + 20 * 3600_000).toISOString(),
  tokenHash, nonce: (++nonceN).toString(16).padStart(32, "0"), ...extra,
});
const permit = async (op, extra = {}) =>
  (await one(db, "SELECT public.omni_execution_permit_action($1,$2::jsonb) AS r", [op, JSON.stringify(args(extra))])).r;
const request = (job = jobA, extra = {}) => permit("request", { jobId: job, kind: "autonomous", digest: dig, estimateUsd: 1, ...extra });
const ready = async () => assert.equal((await authorize(await grant())).ok, true);
const status = async (job = jobA) => (await one(db, "SELECT status, closed_reason FROM public.omni_execution_permits WHERE job_id=$1", [job]));
const audits = async () => (await db.query("SELECT action, outcome, detail FROM public.audit_logs ORDER BY at, ctid")).rows;

test("trusted meter and spending guard pass in the seeded copy (precondition)", async () => {
  assert.equal((await one(db, "SELECT public.code_spend_meter_status()->>'ok' AS ok")).ok, "true");
  assert.equal((await one(db, "SELECT public.code_total_spend_guard_enforced() AS ok")).ok, true);
});

test("owner authorization needs Step 7 window, Step 8 proof, Step 9 handshake, runner and a fresh passkey", async () => {
  assert.deepEqual((await authorize(await grant(), { runner: false })).reasons, ["runner_unavailable"]);
  assert.deepEqual((await authorize(null)).reasons, ["fresh_passkey_required"]);
  assert.deepEqual((await authorize(await grant(db, { target: "omni-autonomy:other" }))).reasons, ["fresh_passkey_required"]);
  assert.deepEqual((await authorize(await grant(db, { cred: "recent:cred-1" }))).reasons, ["fresh_passkey_required"]);
  await db.query("UPDATE public.omni_link_sessions SET expires_at=now()-interval '40 minutes'");
  assert.ok((await authorize(await grant())).reasons.includes("step9_handshake_missing"));
  await db.query("UPDATE public.omni_link_sessions SET expires_at=now()+interval '4 minutes'");
  await db.query("UPDATE public.omni_inbound_jobs SET result='{\"passed\":false,\"checks\":0,\"runner\":\"restricted-protocol-self-test\"}'");
  assert.ok((await authorize(await grant())).reasons.includes("step8_proof_missing"));
  await db.query("UPDATE public.omni_inbound_jobs SET result='{\"passed\":true,\"checks\":3,\"runner\":\"restricted-protocol-self-test\"}', updated_at=now()-interval '2 hours'");
  assert.ok((await authorize(await grant())).reasons.includes("step8_proof_missing"), "proof older than the saved approval");
  await db.query("UPDATE public.omni_inbound_jobs SET updated_at=now()-interval '10 minutes'");
  await db.query("UPDATE public.omni_link_approval SET expires_at=now()-interval '1 minute'");
  assert.ok((await authorize(await grant())).reasons.includes("step7_approval_expired"));
  const memberStep = await grant(db, { user: member });
  await assert.rejects(() => authorize(memberStep, { actor: member }), /Only the owner/);
  const refused = (await audits()).filter((a) => a.action === "omni.autonomy_authorize_refused");
  assert.ok(refused.length >= 6 && refused.every((a) => a.outcome === "refused"));
  assert.equal((await one(db, "SELECT count(*)::int AS n FROM public.omni_autonomy_authorizations")).n, 0);
});

test("authorization is recorded with fixed limits, consumes the passkey once and is idempotent", async () => {
  const step = await grant();
  const r = await authorize(step);
  assert.equal(r.ok, true);
  assert.deepEqual(r.executionBlockedBy, []);
  const row = await one(db, "SELECT daily_limit_usd::text d, per_call_limit_usd::text c, per_task_reserve_usd::text t, step8_job_id, approval_id FROM public.omni_autonomy_authorizations");
  assert.deepEqual(row, { d: "5.00", c: "0.50", t: "1.00", step8_job_id: proofJob, approval_id: approval });
  assert.ok((await one(db, "SELECT used_at FROM public.step_up_grants WHERE id=$1", [step])).used_at);
  const again = await authorize(await grant());
  assert.equal(again.duplicate, true);
  assert.equal(again.id, r.id);
  await assert.rejects(() => db.query("UPDATE public.omni_autonomy_authorizations SET daily_limit_usd=6"), /check/i);
});

test("authorizing while stopped records the decision but never releases anything", async () => {
  await seedControls(db, { enabled: false, stop: true, paused: true });
  const r = await authorize(await grant());
  assert.equal(r.ok, true);
  assert.deepEqual(r.executionBlockedBy, ["kill_switch_on", "emergency_stop_engaged", "code_disabled"]);
  assert.deepEqual(await one(db, "SELECT c.enabled, c.kill_switch, (SELECT paused FROM public.automation_policy WHERE id=1) paused FROM public.code_runtime_controls c"), { enabled: false, kill_switch: true, paused: true });
});

test("all 8 control combinations: a permit is issued only with Kill Switch off, Stop released and CODE on", async () => {
  await ready();
  let i = 0;
  for (const enabled of [false, true]) for (const stop of [false, true]) for (const paused of [false, true]) {
    await db.query("DELETE FROM public.omni_execution_permits");
    await seedControls(db, { enabled, stop, paused });
    const job = `66666666-6666-4666-8666-${String(++i).padStart(12, "0")}`;
    const r = await request(job);
    const expected = paused ? "kill_switch_on" : stop ? "emergency_stop_engaged" : !enabled ? "code_disabled" : null;
    if (expected) {
      assert.equal(r.http, 403, JSON.stringify({ enabled, stop, paused }));
      assert.equal(r.reason, expected);
    } else {
      assert.equal(r.http, 200);
      assert.equal(r.permit.status, "active");
    }
  }
});

test("no authorization, expired approval or wrong owner scope: no permit", async () => {
  assert.equal((await request()).reason, "not_authorized");
  await ready();
  assert.equal((await request(jobA, { approvalExpiresAt: new Date(Date.now() - 1000).toISOString() })).reason, "approval_expired");
  assert.equal((await request(jobA, { ownerId: member })).reason, "owner_scope");
  await revokeAuth();
  assert.equal((await request()).reason, "not_authorized");
});

test("signed session and single-use nonce are required", async () => {
  await ready();
  assert.equal((await request(jobA, { tokenHash: "c".repeat(64) })).http, 401);
  const fixed = { nonce: "f".repeat(32) };
  assert.equal((await request(jobA, fixed)).http, 200);
  assert.deepEqual(await request(jobA, fixed), { http: 409, error: "replay" });
});

test("permit lasts at most 60 s, renews idempotently, and carries the owner limits", async () => {
  await ready();
  const first = await request();
  assert.equal(first.http, 200);
  const ttl = (Date.parse(first.permit.expiresAt) - Date.parse(first.permit.issuedAt)) / 1000;
  assert.ok(ttl > 0 && ttl <= 60, String(ttl));
  assert.deepEqual(first.permit.limits, { perCallUsd: 0.5, perTaskUsd: 1, dailyUsd: 5 });
  const renewed = await request();
  assert.equal(renewed.permit.id, first.permit.id);
  assert.equal(renewed.permit.renewals, 1);
  assert.equal((await one(db, "SELECT count(*)::int n FROM public.audit_logs WHERE action='omni.permit_issued'")).n, 1, "renewals do not re-reserve");
});

test("scope is fixed: kind, digest and the $1 task estimate", async () => {
  await ready();
  assert.equal((await request(jobA, { kind: "deploy" })).reason, "scope_invalid");
  assert.equal((await request(jobA, { estimateUsd: 1.01 })).reason, "scope_invalid");
  assert.equal((await request(jobA, { digest: "nothex" })).reason, "scope_invalid");
  assert.equal((await request()).http, 200);
  const changed = await request(jobA, { digest: "d".repeat(64) });
  assert.equal(changed.reason, "scope_mismatch");
  assert.deepEqual(await status(), { status: "revoked", closed_reason: "scope_mismatch" });
  assert.equal((await request()).reason, "job_closed", "a revoked job never gets a permit again");
});

test("Emergency Stop revokes active permits in the same transaction and blocks renewal", async () => {
  await ready();
  assert.equal((await request()).http, 200);
  await db.query("SELECT * FROM public.engage_code_kill_switch($1)", [owner]);
  assert.deepEqual(await status(), { status: "revoked", closed_reason: "emergency_stop_engaged" });
  assert.ok((await audits()).some((a) => a.action === "omni.permits_revoked" && a.detail.reason === "emergency_stop_engaged" && a.detail.count === 1));
  assert.equal((await request()).reason, "emergency_stop_engaged");
  // The stop never changed the other two controls, and nothing released it.
  assert.deepEqual(await one(db, "SELECT c.enabled, c.kill_switch, (SELECT paused FROM public.automation_policy WHERE id=1) paused FROM public.code_runtime_controls c"), { enabled: true, kill_switch: true, paused: false });
});

test("Kill Switch on and CODE off each revoke active permits", async () => {
  await ready();
  await request();
  await db.query("UPDATE public.automation_policy SET paused=true WHERE id=1");
  assert.deepEqual(await status(), { status: "revoked", closed_reason: "kill_switch_on" });
  await seedControls(db);
  await request(jobB);
  await db.query("SELECT public.set_code_enabled($1,false)", [owner]);
  assert.deepEqual(await status(jobB), { status: "revoked", closed_reason: "code_disabled" });
});

test("a stop still succeeds even if permit revocation cannot run", async () => {
  await ready();
  await request();
  await db.exec("ALTER TABLE public.omni_execution_permits ADD CONSTRAINT block_updates CHECK (status <> 'revoked') NOT VALID");
  await db.query("SELECT * FROM public.engage_code_kill_switch($1)", [owner]);
  assert.equal((await one(db, "SELECT kill_switch FROM public.code_runtime_controls")).kill_switch, true, "stop committed");
  assert.equal((await status()).status, "active", "revocation was blocked in this fixture");
  await db.exec("ALTER TABLE public.omni_execution_permits DROP CONSTRAINT block_updates");
  const r = await request();
  assert.equal(r.reason, "emergency_stop_engaged", "renewal re-checks the stop even when revocation failed");
  assert.equal(r.permit.status, "revoked");
});

test("lapsed permit is closed for good; offline OMNI must restart under a new job", async () => {
  await ready();
  await request();
  const c = await one(db, "SELECT conname FROM pg_constraint WHERE conrelid='public.omni_execution_permits'::regclass AND pg_get_constraintdef(oid) LIKE '%renewed_at%'");
  await db.exec(`ALTER TABLE public.omni_execution_permits DROP CONSTRAINT ${c.conname}`);
  await db.query("UPDATE public.omni_execution_permits SET expires_at=now()-interval '1 second'");
  assert.equal((await request()).reason, "permit_lapsed");
  assert.deepEqual(await status(), { status: "expired", closed_reason: "not_renewed_in_time" });
});

test("one active job at a time and at most $5 of $1 reservations per UTC day", async () => {
  await ready();
  assert.equal((await request(jobA)).http, 200);
  assert.equal((await request(jobB)).reason, "concurrency_limit");
  assert.equal((await permit("release", { jobId: jobA })).permit.status, "released");
  assert.equal((await permit("release", { jobId: jobA })).permit.status, "released", "release is idempotent");
  for (let i = 0; i < 4; i++) {
    const job = `88888888-8888-4888-8888-${String(i).padStart(12, "0")}`;
    assert.equal((await request(job)).http, 200, `job ${i}`);
    await permit("release", { jobId: job });
  }
  assert.equal((await request(jobB)).reason, "daily_limit");
});

test("revoking the owner authorization revokes active permits", async () => {
  await ready();
  await request();
  const r = await revokeAuth();
  assert.equal(r.revokedPermits, 1);
  assert.deepEqual(await status(), { status: "revoked", closed_reason: "authorization_revoked" });
});

test("safety snapshot reports the effective gate, valid for 30 s, and manual diagnostics follow only the Kill Switch", async () => {
  await seedControls(db, { enabled: true, stop: true, paused: false });
  const s = (await permit("safety")).safety;
  assert.equal(s.autonomousAllowed, false);
  assert.equal(s.blockedBy, "emergency_stop_engaged");
  assert.equal(s.manualDiagnosticsAllowed, true);
  assert.ok(Date.parse(s.validUntil) - Date.parse(s.checkedAt) <= 30_000);
  await seedControls(db, { paused: true });
  assert.equal((await permit("safety")).safety.manualDiagnosticsAllowed, false);
  await seedControls(db);
  await ready();
  assert.equal((await permit("safety")).safety.autonomousAllowed, true);
});

test("functions and tables are server-only", async () => {
  for (const fn of ["omni_autonomy_authorization_action(text,uuid,text,uuid,uuid,boolean,text)", "omni_execution_permit_action(text,jsonb)", "omni_permits_revoke_on_stop()"]) {
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await one(db, `SELECT has_function_privilege('${role}','public.${fn}','EXECUTE') ok`)).ok, false, `${role} ${fn}`);
    }
  }
  for (const t of ["omni_autonomy_authorizations", "omni_execution_permits"]) {
    assert.equal((await one(db, `SELECT has_table_privilege('authenticated','public.${t}','SELECT') ok`)).ok, false);
  }
});

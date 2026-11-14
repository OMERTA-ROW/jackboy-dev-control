// Real PostgreSQL engine (PGlite) over the full migration chain (0066-0070 included) plus the staged,
// NOT installed scripts/omni-autonomy-scope-draft.sql. Durable owner authorization for OMNI autonomous
// work: passkey-confirmed, scoped to OMNI client/project/approval/expiry and allowed capabilities, kept
// as history, and re-checked with every live safety gate on each permit request and renewal.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrationFiles, supabaseStubs } from "./helpers/staging-pg.mjs";

const DRAFT = "scripts/omni-autonomy-scope-draft.sql";
const owner = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const owner2 = "99999999-9999-4999-8999-999999999999";
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
  const files = await migrationFiles();
  assert.ok(files.includes("0070_omni_safety_generation.sql"), "draft must follow 0070");
  for (const f of files) await base.exec(await readFile(`drizzle/migrations/${f}`, "utf8"));
  await base.exec(await readFile(DRAFT, "utf8"));
  await base.query("INSERT INTO auth.users(id,email) VALUES ($1,'o@x.test'),($2,'m@x.test'),($3,'o2@x.test')", [owner, member, owner2]);
  await base.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1,'owner'),($2,'member'),($3,'admin')", [owner, member, owner2]);
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
  await base.query("INSERT INTO public.owner_passkeys(user_id,credential_id,public_key) VALUES ($1,'cred-owner-secret-id','pk'),($2,'cred-owner2','pk2')", [owner, owner2]);
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

async function grant(d = db, { user = owner, cred = user === owner ? "cred-owner-secret-id" : "cred-owner2" } = {}) {
  return (await one(d, "INSERT INTO public.step_up_grants(user_id,action,target,credential_id,expires_at) VALUES ($1,'omni_autonomy',$2,$3,now()+interval '5 minutes') RETURNING id", [user, `omni-autonomy:${approval}`, cred])).id;
}
const authorize = async (step, caps = ["autonomous", "code"], { actor = owner, d = db } = {}) =>
  (await one(d, "SELECT public.omni_autonomy_authorize_scoped($1,$2,$3,$4,true,$5::text[]) AS r", [actor, client, project, step, caps])).r;
const revokeAuth = async (actor = owner) =>
  (await one(db, "SELECT public.omni_autonomy_authorization_action('revoke',$1,$2,$3,NULL,NULL,'test') AS r", [actor, client, project])).r;
const args = (extra = {}) => ({
  clientId: client, projectId: project, approvalId: approval, ownerId: owner,
  approvalExpiresAt: new Date(Date.now() + 20 * 3600_000).toISOString(),
  tokenHash, nonce: (++nonceN).toString(16).padStart(32, "0"), ...extra,
});
const permit = async (op, extra = {}, d = db) =>
  (await one(d, "SELECT public.omni_execution_permit_action($1,$2::jsonb) AS r", [op, JSON.stringify(args(extra))])).r;
const request = (job = jobA, extra = {}, d = db) =>
  permit("request", { jobId: job, kind: "autonomous", digest: dig, estimateUsd: 1, ...extra }, d);
const status = async (job = jobA) => one(db, "SELECT status, closed_reason FROM public.omni_execution_permits WHERE job_id=$1", [job]);
const auths = async (d = db) => (await d.query("SELECT id, owner_id, capabilities, revoked_at, revoked_reason FROM public.omni_autonomy_authorizations ORDER BY created_at, ctid")).rows;
const controls = async () => one(db, "SELECT c.enabled, c.kill_switch, (SELECT paused FROM public.automation_policy WHERE id=1) paused FROM public.code_runtime_controls c");

test("authorization is stored only after the owner's fresh passkey, with the chosen capabilities", async () => {
  assert.deepEqual((await authorize(null, ["code"])).reasons, ["fresh_passkey_required"]);
  assert.equal((await auths()).length, 0, "nothing stored without a passkey");
  const step = await grant();
  const r = await authorize(step, ["code", "code"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.capabilities, ["code"]);
  const [row] = await auths();
  assert.equal(row.owner_id, owner);
  assert.deepEqual(row.capabilities, ["code"]);
  assert.ok((await one(db, "SELECT used_at FROM public.step_up_grants WHERE id=$1", [step])).used_at, "passkey grant is single-use");
  const again = await authorize(await grant(), ["code"]);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, r.id);
});

test("capabilities must be a non-empty subset of autonomous/code", async () => {
  await assert.rejects(() => authorize(null, []), /at least one/);
  await assert.rejects(() => authorize(null, ["deploy"]), /autonomous and code/);
  await assert.rejects(() => authorize(null, ["code", null]), /autonomous and code/);
  assert.equal((await auths()).length, 0);
});

test("every permit request and renewal enforces the allowed capability", async () => {
  await authorize(await grant(), ["code"]);
  const refused = await request(jobA, { kind: "autonomous" });
  assert.equal(refused.http, 403);
  assert.equal(refused.reason, "capability_not_authorized");
  assert.equal((await request(jobB, { kind: "code" })).http, 200);
  assert.equal((await request(jobB, { kind: "code" })).permit.renewals, 1);
  const s = (await permit("safety")).safety;
  assert.deepEqual(s.authorization.capabilities, ["code"]);
});

test("changing capabilities needs an explicit revoke first; history is kept", async () => {
  await authorize(await grant(), ["code"]);
  const widen = await authorize(await grant(), ["autonomous", "code"]);
  assert.deepEqual(widen.reasons, ["capabilities_change_requires_revoke"]);
  await revokeAuth();
  const r = await authorize(await grant(), ["autonomous", "code"]);
  assert.equal(r.ok, true);
  const rows = await auths();
  assert.equal(rows.length, 2, "the revoked authorization is kept as history");
  assert.ok(rows[0].revoked_at);
  assert.equal(rows[1].revoked_at, null);
});

test("history is append-only: no delete, no scope change, no un-revoke, no later widening or narrowing", async () => {
  await authorize(await grant(), ["code"]);
  await assert.rejects(() => db.query("DELETE FROM public.omni_autonomy_authorizations"), /kept/);
  await assert.rejects(() => db.query("TRUNCATE public.omni_autonomy_authorizations CASCADE"), /kept/);
  await assert.rejects(() => db.query("UPDATE public.omni_autonomy_authorizations SET expires_at=expires_at+interval '1 minute'"), /immutable/);
  await assert.rejects(() => db.query("UPDATE public.omni_autonomy_authorizations SET owner_id=$1", [owner2]), /immutable/);
  await assert.rejects(() => db.query("UPDATE public.omni_autonomy_authorizations SET capabilities=ARRAY['autonomous','code']"), /narrowed/);
  await revokeAuth();
  await assert.rejects(() => db.query("UPDATE public.omni_autonomy_authorizations SET revoked_at=NULL"), /final/);
});

test("wrong owner: other accounts cannot authorize or revoke, and another account's passkey does not count", async () => {
  await assert.rejects(() => authorize(null, ["code"], { actor: member }), /Only the owner/);
  await assert.rejects(() => revokeAuth(member), /Only the owner/);
  const adminStep = await grant(db, { user: owner2 });
  await assert.rejects(() => authorize(adminStep, ["code"], { actor: owner2 }), /Only the owner/);
  // The owner cannot use a passkey confirmation made by another account.
  assert.deepEqual((await authorize(await grant(db, { user: owner2 }))).reasons, ["fresh_passkey_required"]);
  assert.equal((await auths()).length, 0);
  await authorize(await grant());
  assert.equal((await request(jobA, {})).http, 200);
  const wrong = await request(jobA, { ownerId: owner2 });
  assert.equal(wrong.reason, "owner_scope");
  assert.deepEqual(await status(), { status: "revoked", closed_reason: "owner_scope" }, "renewal under another account closes the permit");
  const s = (await permit("safety", { ownerId: member })).safety;
  assert.equal(s.autonomousAllowed, false);
  assert.equal(s.blockedBy, "owner_scope");
});

test("a new owner never inherits the previous owner's authorization", async () => {
  await authorize(await grant());
  // Simulate an ownership transfer of the account role and the OMNI project.
  await db.exec("ALTER TABLE public.user_roles DISABLE TRIGGER USER; ALTER TABLE public.owner_projects DISABLE TRIGGER USER");
  await db.query("UPDATE public.user_roles SET role='admin' WHERE user_id=$1", [owner]);
  await db.query("UPDATE public.user_roles SET role='owner' WHERE user_id=$1", [owner2]);
  await db.query("UPDATE public.owner_projects SET created_by=$1 WHERE id=$2", [owner2, project]);
  await db.exec("ALTER TABLE public.user_roles ENABLE TRIGGER USER; ALTER TABLE public.owner_projects ENABLE TRIGGER USER");
  const r = await request(jobA, { ownerId: owner2 });
  assert.equal(r.http, 403);
  assert.equal(r.reason, "owner_scope", "authorization stays bound to the owner who confirmed it");
  assert.equal((await one(db, "SELECT count(*)::int n FROM public.omni_execution_permits")).n, 0);
});

test("expiry: an expired authorization or Step 7 approval refuses issue and renewal", async () => {
  await authorize(await grant());
  assert.equal((await request()).http, 200);
  assert.equal((await request(jobA, { approvalExpiresAt: new Date(Date.now() - 1000).toISOString() })).reason, "approval_expired");
  await authorize(await grant()); // duplicate, still valid
  await db.exec("ALTER TABLE public.omni_autonomy_authorizations DISABLE TRIGGER USER");
  await db.query("UPDATE public.omni_autonomy_authorizations SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 second'");
  await db.exec("ALTER TABLE public.omni_autonomy_authorizations ENABLE TRIGGER USER");
  assert.equal((await request(jobB)).reason, "not_authorized");
  assert.equal((await permit("safety")).safety.authorization, null);
});

test("revocation closes the active permit at once and blocks the next renewal", async () => {
  await authorize(await grant());
  assert.equal((await request()).http, 200);
  const r = await revokeAuth();
  assert.equal(r.revokedPermits, 1);
  assert.deepEqual(await status(), { status: "revoked", closed_reason: "authorization_revoked" });
  assert.equal((await request()).reason, "not_authorized");
});

test("a valid authorization never bypasses the Kill Switch, Emergency Stop, CODE setting or spending caps", async () => {
  await authorize(await grant());
  assert.equal((await request()).http, 200);
  await db.query("SELECT * FROM public.engage_code_kill_switch($1)", [owner]);
  assert.deepEqual(await status(), { status: "revoked", closed_reason: "emergency_stop_engaged" });
  assert.equal((await request(jobB)).reason, "emergency_stop_engaged");
  assert.equal((await auths())[0].revoked_at, null, "the owner's authorization itself survives a stop");
  assert.deepEqual(await controls(), { enabled: true, kill_switch: true, paused: false }, "nothing else changed");
  await seedControls(db, { paused: true });
  assert.equal((await request(jobB)).reason, "kill_switch_on");
  await seedControls(db, { enabled: false });
  assert.equal((await request(jobB)).reason, "code_disabled");
  await seedControls(db);
  assert.equal((await request(jobA)).reason, "job_closed", "the stopped job never resumes");
  assert.equal((await request(jobB, { estimateUsd: 1.01 })).reason, "scope_invalid", "per-job $1 cap");
  // capability refusal still yields to an engaged stop
  await authorize(await grant()); // duplicate
  await seedControls(db, { stop: true });
  assert.equal((await request(jobB, { kind: "code" })).reason, "emergency_stop_engaged");
});

test("survives a database restart: authorization and revocation persist, gates re-run after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omni-auth-restart-"));
  try {
    await authorize(await grant(), ["autonomous"]);
    const file = join(dir, "data.tar");
    await writeFile(file, Buffer.from(await (await db.dumpDataDir("none")).arrayBuffer()));
    await db.close();
    db = null;
    let restarted = await PGlite.create({ loadDataDir: new Blob([await readFile(file)]) });
    const [row] = await auths(restarted);
    assert.deepEqual(row.capabilities, ["autonomous"]);
    assert.equal(row.revoked_at, null);
    assert.equal((await request(jobA, {}, restarted)).http, 200, "permit issued after restart");
    assert.equal((await request(jobB, { kind: "code" }, restarted)).reason, "capability_not_authorized");
    await restarted.query("SELECT public.omni_autonomy_authorization_action('revoke',$1,$2,$3,NULL,NULL,'restart test')", [owner, client, project]);
    await writeFile(file, Buffer.from(await (await restarted.dumpDataDir("none")).arrayBuffer()));
    await restarted.close();
    restarted = await PGlite.create({ loadDataDir: new Blob([await readFile(file)]) });
    assert.ok((await auths(restarted))[0].revoked_at, "revocation persists after restart");
    assert.equal((await request(jobA, {}, restarted)).reason, "not_authorized");
    db = restarted;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit history records each decision and never stores tokens, passkey credentials or grant ids", async () => {
  const step = await grant();
  await authorize(null, ["code"]);
  await authorize(step, ["code"]);
  await request(jobA, { kind: "autonomous" });
  await request(jobB, { kind: "code" });
  await revokeAuth();
  const rows = (await db.query("SELECT action, outcome, detail::text AS d FROM public.audit_logs ORDER BY at, ctid")).rows;
  const actions = rows.map((r) => r.action);
  for (const a of ["omni.autonomy_authorize_refused", "omni.autonomy_authorized", "omni.autonomy_scope", "omni.permit_refused", "omni.permit_issued", "omni.autonomy_revoked"]) {
    assert.ok(actions.includes(a), a);
  }
  const scope = rows.find((r) => r.action === "omni.autonomy_scope");
  assert.deepEqual(JSON.parse(scope.d).capabilities, ["code"]);
  const all = rows.map((r) => r.d).join("\n");
  for (const secret of [tokenHash, "cred-owner-secret-id", step, "Bearer", "public_key"]) {
    assert.ok(!all.includes(secret), `audit must not contain ${secret}`);
  }
});

test("new functions are server-only and the draft never writes a switch", async () => {
  for (const fn of ["omni_autonomy_authorize_scoped(uuid,text,uuid,uuid,boolean,text[])", "omni_execution_permit_action(text,jsonb)", "omni_execution_permit_action_without_owner_scope(text,jsonb)", "omni_autonomy_authorization_guard()"]) {
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await one(db, `SELECT has_function_privilege('${role}','public.${fn}','EXECUTE') ok`)).ok, false, `${role} ${fn}`);
    }
  }
  assert.equal((await one(db, "SELECT has_function_privilege('service_role','public.omni_execution_permit_action_without_owner_scope(text,jsonb)','EXECUTE') ok")).ok, false);
  const sql = await readFile(DRAFT, "utf8");
  assert.ok(!/UPDATE\s+public\.(automation_policy|code_runtime_controls)/i.test(sql));
  const { entries } = JSON.parse(await readFile("drizzle/migrations/meta/_journal.json", "utf8"));
  assert.ok(!entries.some((e) => /autonomy_scope/.test(e.tag)), "staged only, not journaled");
});

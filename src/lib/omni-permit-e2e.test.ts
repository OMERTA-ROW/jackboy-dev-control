// @vitest-environment node
// End-to-end proof on an ISOLATED database copy (PGlite, full production migration chain incl. 0066):
// the real signed permit handler + the real database rules + the real owner stop actions, driven by a
// synthetic no-op job that follows the OMNI contract (renew before every step, halt on any refusal).
// No network, no production data, no real job, nothing paid.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrationFiles, supabaseStubs } from "../../tests/helpers/staging-pg.mjs";
import { handleOmniPermit, type PermitStore } from "./omni-permit.server";
import { autonomyState, permitSigningMessage, permitUsable, type AutonomyStatusInput } from "./omni-permit";
import { digest, requestMessage, LINK_CONTRACT } from "./omni-session";
import { hmacHex } from "./omni-link";
import type { LinkConfig, StoreReply } from "./omni-session.server";

const owner = "11111111-1111-4111-8111-111111111111";
const project = "33333333-3333-4333-8333-333333333333";
const approval = "44444444-4444-4444-8444-444444444444";
const proofJob = "55555555-5555-4555-8555-555555555555";
const SECRET = "e".repeat(64);
const TOKEN = "f".repeat(64);
const DIG = "c".repeat(64);
const cfg: LinkConfig = {
  clientId: "OMNI", projectId: project, ownerId: owner, approvalId: approval,
  approvalExpiresAt: new Date(Date.now() + 20 * 3600_000).toISOString(), bootstrap: "b".repeat(64), secret: SECRET,
};

let base: PGlite;
let db: PGlite;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0] as T;
const store: PermitStore = async (op, args) =>
  (await one<{ r: StoreReply }>("SELECT public.omni_execution_permit_action($1,$2::jsonb) AS r", [op, JSON.stringify(args)])).r;

async function fixtureControls({ enabled = true, stop = false, paused = false } = {}) {
  // Fixture-only seeding (triggers off); every stop under test uses the real owner action.
  await db.exec("ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER");
  await db.query("UPDATE public.code_runtime_controls SET enabled=$1, kill_switch=$2", [enabled, stop]);
  await db.exec("ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER");
  await db.exec("ALTER TABLE public.automation_policy DISABLE TRIGGER USER");
  await db.query("UPDATE public.automation_policy SET paused=$1 WHERE id=1", [paused]);
  await db.exec("ALTER TABLE public.automation_policy ENABLE TRIGGER USER");
}

type Call = { status: number; body: Record<string, any>; proofOk: boolean };
async function call(body: Record<string, unknown>, { token = TOKEN, replay }: { token?: string; replay?: { raw: string; headers: Headers } } = {}): Promise<Call & { raw: string; headers: Headers }> {
  const raw = replay?.raw ?? JSON.stringify(body);
  let headers = replay?.headers;
  if (!headers) {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const ts = String(Math.floor(Date.now() / 1000));
    headers = new Headers({
      authorization: `Bearer ${token}`, "x-omni-client": "OMNI", "x-omni-nonce": nonce, "x-omni-timestamp": ts,
      "x-omni-signature": await hmacHex(SECRET, requestMessage(ts, nonce, await digest(token), raw)),
    });
  }
  const res = await handleOmniPermit(new Request("https://jackboy.lovable.app/api/public/omni/link", { method: "POST", body: raw, headers }), raw, cfg, store, {});
  const text = await res.text();
  const proof = res.headers.get("x-omni-proof");
  const proofOk = !!proof && proof === (await hmacHex(SECRET, `${LINK_CONTRACT}\nresponse\n${headers.get("x-omni-nonce")}\n${res.status}\n${text}`));
  return { status: res.status, body: JSON.parse(text), proofOk, raw, headers };
}
const safety = () => call({ action: "safety", projectId: project });
const permitReq = (jobId: string) => call({ action: "permit.request", projectId: project, jobId, kind: "autonomous", digest: DIG, estimateUsd: 1 });

/** OMNI-side verification of a permit, as the contract requires (signature, scope, ≤ 60 s, limits). */
async function permitValid(p: Record<string, any> | undefined, jobId: string) {
  if (!p || !permitUsable(p)) return false;
  const sig = await hmacHex(SECRET, permitSigningMessage({ permitId: p["id"], jobId: p["jobId"], kind: p["kind"], digest: p["digest"], clientId: p["clientId"], projectId: p["projectId"], approvalId: p["approvalId"], expiresAt: p["expiresAt"] }));
  return sig === p["signature"] && p["jobId"] === jobId && p["digest"] === DIG && p["clientId"] === "OMNI" && p["projectId"] === project
    && p["approvalId"] === approval && Date.parse(p["expiresAt"]) <= Date.now() + 61_000
    && p["limits"].perCallUsd <= 0.5 && p["limits"].perTaskUsd <= 1 && p["limits"].dailyUsd <= 5;
}

/** Synthetic no-op job: renews before every step and halts forever on any refusal. Does nothing else. */
class NoopJob {
  steps = 0;
  halted: string | null = null;
  constructor(readonly id: string) {}
  async step() {
    if (this.halted) return false;
    const r = await permitReq(this.id);
    if (r.status !== 200 || !r.proofOk || !(await permitValid(r.body["permit"], this.id))) {
      this.halted = r.body["reason"] ?? r.body["error"] ?? "invalid_permit";
      return false;
    }
    this.steps += 1; // the "work": nothing
    return true;
  }
}

const job = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
async function authorizeOwner() {
  const g = await one<{ id: string }>("INSERT INTO public.step_up_grants(user_id,action,target,credential_id,expires_at) VALUES ($1,'omni_autonomy',$2,'cred-1',now()+interval '5 minutes') RETURNING id", [owner, `omni-autonomy:${approval}`]);
  return (await one<{ r: any }>("SELECT public.omni_autonomy_authorization_action('authorize',$1,'OMNI',$2,$3,true,NULL) AS r", [owner, project, g.id])).r;
}
const audits = async () => (await db.query<{ action: string; outcome: string; detail: any }>("SELECT action, outcome, detail FROM public.audit_logs WHERE action LIKE 'omni.%' ORDER BY at, ctid")).rows;
const permitRow = (jobId: string) => one<{ status: string; closed_reason: string | null }>("SELECT status, closed_reason FROM public.omni_execution_permits WHERE job_id=$1", [jobId]);

/** Backend-derived state from the same rows the owner's status reader uses. */
async function backendState() {
  const auth = await one<{ expires_at: string } | undefined>("SELECT expires_at::text FROM public.omni_autonomy_authorizations WHERE revoked_at IS NULL AND expires_at > now() LIMIT 1");
  const c = await one<{ enabled: boolean; kill_switch: boolean; paused: boolean }>("SELECT c.enabled, c.kill_switch, (SELECT paused FROM public.automation_policy WHERE id=1) paused FROM public.code_runtime_controls c");
  const permits = (await db.query<{ status: string; expires_at: string }>("SELECT status, expires_at::text FROM public.omni_execution_permits")).rows;
  const input: AutonomyStatusInput = {
    installed: true, linkConfigured: true, approval: { approvalId: approval, expiresAt: cfg.approvalExpiresAt },
    step8ProofAt: new Date().toISOString(), lastHandshakeAt: new Date().toISOString(), runnerReady: true, meterOk: true, guardEnforced: true,
    killSwitch: c.paused, emergencyStop: c.kill_switch, codeEnabled: c.enabled,
    authorization: auth ? { expiresAt: new Date(auth.expires_at).toISOString() } : null,
  };
  return autonomyState(input, permits.map((p) => ({ ...p, expires_at: new Date(p.expires_at).toISOString() }))).id;
}

beforeAll(async () => {
  base = new PGlite();
  await base.exec(supabaseStubs);
  const files = await migrationFiles();
  expect(files).toContain("0066_omni_execution_permits.sql");
  for (const f of files) await base.exec(await readFile(`drizzle/migrations/${f}`, "utf8"));
  await base.query("INSERT INTO auth.users(id,email) VALUES ($1,'o@x.test')", [owner]);
  await base.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1,'owner')", [owner]);
  await base.exec("INSERT INTO public.automation_policy(id, paused) VALUES (1, false) ON CONFLICT (id) DO NOTHING");
  await base.query("INSERT INTO public.owner_projects(id,name,created_by) VALUES ($1,'OMNI',$2)", [project, owner]);
  await base.query("INSERT INTO public.omni_link_approval(id,approval_id,expires_at,saved_by,saved_at) VALUES (1,$1,now()+interval '20 hours',$2,now()-interval '1 hour')", [approval, owner]);
  await base.query(
    `INSERT INTO public.omni_inbound_jobs(id,client_id,project_id,approval_id,kind,status,deadline,updated_at,result)
     VALUES ($1,'OMNI',$2,$3,'protocol.self-test','completed',now(),now()-interval '10 minutes','{"passed":true,"checks":3,"runner":"restricted-protocol-self-test"}')`,
    [proofJob, project, approval],
  );
  await base.query("INSERT INTO public.omni_link_sessions VALUES ($1,'OMNI',$2,$3,now()+interval '4 minutes')", [await digest(TOKEN), project, approval]);
  await base.query("INSERT INTO public.owner_passkeys(user_id,credential_id,public_key) VALUES ($1,'cred-1','pk')", [owner]);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await base?.close();
});
beforeEach(async () => {
  await db?.close();
  db = (await base.clone()) as PGlite;
  await fixtureControls();
});

describe("OMNI autonomy end to end (isolated copy, synthetic no-op job)", () => {
  it("not configured: no owner authorization means a signed request is refused and the job never starts", async () => {
    expect(await backendState()).toBe("not_configured");
    const s = await safety();
    expect(s.status).toBe(200);
    expect(s.proofOk).toBe(true);
    expect(s.body["safety"]).toMatchObject({ contract: "omni.safety/v1", autonomousAllowed: false, blockedBy: "not_authorized", authorization: null });
    const j = new NoopJob(job(1));
    expect(await j.step()).toBe(false);
    expect(j).toMatchObject({ steps: 0, halted: "not_authorized" });
    expect((await one<{ n: number }>("SELECT count(*)::int n FROM public.omni_execution_permits")).n).toBe(0);
  });

  it("configured → armed → running → armed: persisted authorization, fresh signed permit decision, audited", async () => {
    const auth = await authorizeOwner();
    expect(auth).toMatchObject({ ok: true, duplicate: false, executionBlockedBy: [] });
    const row = await one("SELECT client_id, project_id, approval_id, step8_job_id, daily_limit_usd::text d, per_call_limit_usd::text c, per_task_reserve_usd::text t, revoked_at FROM public.omni_autonomy_authorizations");
    expect(row).toEqual({ client_id: "OMNI", project_id: project, approval_id: approval, step8_job_id: proofJob, d: "5.00", c: "0.50", t: "1.00", revoked_at: null });
    expect(await backendState()).toBe("armed");

    const s = await safety();
    expect(s.proofOk).toBe(true);
    expect(s.body["safety"]).toMatchObject({ autonomousAllowed: true, blockedBy: null, killSwitch: false, emergencyStop: false, codeEnabled: true, activePermits: 0 });

    const j = new NoopJob(job(2));
    expect(await j.step()).toBe(true);
    expect(await j.step()).toBe(true); // renewal re-checks every gate
    expect(j.steps).toBe(2);
    expect(await backendState()).toBe("running");
    expect(await permitRow(job(2))).toEqual({ status: "active", closed_reason: null });

    const rel = await call({ action: "permit.release", projectId: project, jobId: job(2) });
    expect(rel.status).toBe(200);
    expect(rel.body["permit"]).toMatchObject({ status: "released" });
    expect(await backendState()).toBe("armed");
    expect((await audits()).map((a) => a.action)).toEqual(["omni.autonomy_authorized", "omni.permit_issued", "omni.permit_released"]);
  });

  it("configured but held: CODE off, Emergency Stop or Kill Switch each refuse a new permit (no permit row created)", async () => {
    await authorizeOwner();
    for (const [controls, reason] of [
      [{ enabled: false }, "code_disabled"],
      [{ stop: true }, "emergency_stop_engaged"],
      [{ paused: true }, "kill_switch_on"],
    ] as const) {
      await fixtureControls(controls);
      expect(await backendState()).toBe("configured");
      const j = new NoopJob(job(3));
      expect(await j.step()).toBe(false);
      expect(j.halted).toBe(reason);
    }
    expect((await safety()).body["safety"]).toMatchObject({ manualDiagnosticsAllowed: false, autonomousAllowed: false });
    await fixtureControls({ stop: true });
    expect((await safety()).body["safety"]).toMatchObject({ manualDiagnosticsAllowed: true, autonomousAllowed: false, blockedBy: "emergency_stop_engaged" });
    expect((await one<{ n: number }>("SELECT count(*)::int n FROM public.omni_execution_permits")).n).toBe(0);
  });

  it("cancellation: the owner's real stop actions revoke a running job's permit at once; it halts and never resumes", async () => {
    await authorizeOwner();
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ["Emergency Stop", () => db.query("SELECT * FROM public.engage_code_kill_switch($1)", [owner]), "emergency_stop_engaged"],
      ["CODE off", () => db.query("SELECT public.set_code_enabled($1,false)", [owner]), "code_disabled"],
      ["Kill Switch", async () => {
        await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
        const p = await one<{ tier: number; max_files: number; max_lines: number }>("SELECT tier, max_files, max_lines FROM public.automation_policy WHERE id=1");
        await db.query("SELECT public.set_automation_policy($1,true,$2,$3)", [p.tier, p.max_files, p.max_lines]);
      }, "kill_switch_on"],
    ];
    let n = 10;
    for (const [, stop, reason] of cases) {
      await fixtureControls();
      const j = new NoopJob(job(++n));
      expect(await j.step()).toBe(true);
      await stop();
      expect(await permitRow(j.id)).toEqual({ status: "revoked", closed_reason: reason }); // same transaction as the stop
      expect(await j.step()).toBe(false);
      expect(j.halted).toBe(reason);
      expect(j.steps).toBe(1);
      await fixtureControls(); // even after everything is released again…
      const again = await permitReq(j.id);
      expect(again.status).toBe(403);
      expect(again.body["reason"]).toBe("job_closed"); // …the cancelled job can't come back
      const revoked = (await audits()).filter((a) => a.action === "omni.permits_revoked").at(-1);
      expect(revoked?.detail).toEqual({ reason, count: 1 });
    }
  });

  it("stale and revoked permits are refused; replay, expired session and bootstrap key are rejected", async () => {
    await authorizeOwner();
    const lapsed = new NoopJob(job(20));
    expect(await lapsed.step()).toBe(true);
    await db.query("UPDATE public.omni_execution_permits SET renewed_at=now()-interval '61 seconds', expires_at=now()-interval '1 second' WHERE job_id=$1", [job(20)]);
    expect(await lapsed.step()).toBe(false);
    expect(lapsed.halted).toBe("permit_lapsed");
    expect(await permitRow(job(20))).toEqual({ status: "expired", closed_reason: "not_renewed_in_time" });

    const revokedJob = new NoopJob(job(21));
    expect(await revokedJob.step()).toBe(true);
    const r = await one<{ r: any }>("SELECT public.omni_autonomy_authorization_action('revoke',$1,'OMNI',$2,NULL,NULL,'test') AS r", [owner, project]);
    expect(r.r).toMatchObject({ ok: true, revokedAuthorizations: 1, revokedPermits: 1 });
    expect(await revokedJob.step()).toBe(false);
    expect(revokedJob.halted).toBe("not_authorized");
    expect(await backendState()).toBe("not_configured");

    const first = await safety();
    const replayed = await call({}, { replay: { raw: first.raw, headers: first.headers } });
    expect([replayed.status, replayed.body["error"]]).toEqual([409, "replay"]);
    const boot = await call({ action: "safety", projectId: project }, { token: cfg.bootstrap });
    expect([boot.status, boot.body["error"]]).toEqual([401, "authentication_failed"]);
    await db.query("UPDATE public.omni_link_sessions SET expires_at=now()-interval '1 second'");
    const stale = await safety();
    expect([stale.status, stale.body["error"]]).toEqual([401, "session_expired_or_invalid"]);
  });

  it("a tampered permit fails the OMNI-side check", async () => {
    await authorizeOwner();
    const r = await permitReq(job(30));
    expect(await permitValid(r.body["permit"], job(30))).toBe(true);
    expect(await permitValid({ ...r.body["permit"], expiresAt: new Date(Date.now() + 3600_000).toISOString() }, job(30))).toBe(false);
    expect(await permitValid(r.body["permit"], job(31))).toBe(false);
  });
});

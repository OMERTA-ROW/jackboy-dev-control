// Owner-only: Jackboy's own permission for OMNI autonomous/CODE work (the "key"). Authorizing records
// a passkey-confirmed decision; it never releases a stop, changes a switch, starts a job or rotates a
// key. OMNI still needs a fresh permit for every job, refused while any stop is on.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { autonomyGates } from "./omni-permit";

type Ctx = { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> }; userId: string };
async function requireOwner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can change OMNI autonomous permission.");
}
const admin = async () => (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);

async function runnerReady(): Promise<boolean> {
  const { protocolRunnerAvailable } = await import("./omni-session-runner.server");
  const { remoteRunnerConfig } = await import("./omni-remote-runner");
  return protocolRunnerAvailable() || Boolean(remoteRunnerConfig(process.env));
}

export type PermitRow = {
  id: string;
  job_id: string;
  job_kind: string;
  status: string;
  issued_at: string;
  expires_at: string;
  renewals: number;
  closed_at: string | null;
  closed_reason: string | null;
};

export const getOmniAutonomyStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const db = await admin();
    const { resolvedLinkConfig } = await import("./omni-session.server");
    const link = await resolvedLinkConfig();
    const clientId = process.env["OMNI_LINK_CLIENT_ID"] || "";
    const projectId = process.env["OMNI_LINK_PROJECT_ID"] || "";
    const [approvalR, pausedR, controlsR, meterR, guardR, authR, permitsR] = await Promise.all([
      db.from("omni_link_approval").select("approval_id, expires_at, saved_at").eq("id", 1).maybeSingle(),
      db.from("automation_policy").select("paused").eq("id", 1).maybeSingle(),
      db.from("code_runtime_controls").select("enabled, kill_switch").eq("singleton", true).maybeSingle(),
      db.rpc("code_spend_meter_status"),
      db.rpc("code_total_spend_guard_enforced"),
      db.from("omni_autonomy_authorizations").select("id, approval_id, expires_at, created_at, step8_job_id, daily_limit_usd, per_call_limit_usd, per_task_reserve_usd").is("revoked_at", null).order("created_at", { ascending: false }).limit(1),
      db.from("omni_execution_permits").select("id, job_id, job_kind, status, issued_at, expires_at, renewals, closed_at, closed_reason").order("issued_at", { ascending: false }).limit(10),
    ]);
    const approval = approvalR.error || !approvalR.data ? null : (approvalR.data as { approval_id: string; expires_at: string; saved_at: string });
    let step8ProofAt: string | null = null;
    let lastHandshakeAt: string | null = null;
    if (approval && clientId && projectId) {
      const [proof, session] = await Promise.all([
        db.from("omni_inbound_jobs").select("updated_at, result").eq("client_id", clientId).eq("project_id", projectId).eq("approval_id", approval.approval_id).eq("status", "completed").gte("updated_at", approval.saved_at).order("updated_at", { ascending: false }).limit(5),
        db.from("omni_link_sessions").select("expires_at").eq("client_id", clientId).eq("project_id", projectId).eq("approval_id", approval.approval_id).order("expires_at", { ascending: false }).limit(1),
      ]);
      const passed = ((proof.data ?? []) as Array<{ updated_at: string; result: Record<string, unknown> | null }>).find(
        (r) => r.result?.["passed"] === true && Number(r.result?.["checks"]) === 3 && r.result?.["runner"] === "restricted-protocol-self-test",
      );
      step8ProofAt = passed?.updated_at ?? null;
      const s = (session.data ?? [])[0] as { expires_at: string } | undefined;
      // Sessions last 5 minutes, so the handshake happened about 5 minutes before the session's end.
      lastHandshakeAt = s ? new Date(Date.parse(s.expires_at) - 5 * 60_000).toISOString() : null;
    }
    // Missing table → not installed; any other read error → unknown (still blocked, but not mislabelled).
    const missing = (e: unknown) => {
      const code = (e as { code?: string } | null)?.code;
      return code === "42P01" || code === "PGRST205";
    };
    const installed: boolean | null =
      !authR.error && !permitsR.error ? true : missing(authR.error) || missing(permitsR.error) ? false : null;
    const auth = installed === true ? ((authR.data ?? [])[0] as Record<string, unknown> | undefined) ?? null : null;
    const controls = controlsR.error || !controlsR.data ? null : (controlsR.data as { enabled: boolean; kill_switch: boolean });
    const meter = meterR.error ? null : (meterR.data as { ok?: unknown } | null);
    const ready = await runnerReady();
    const input = {
      installed,
      linkConfigured: Boolean(link),
      approval: approval ? { approvalId: approval.approval_id, expiresAt: approval.expires_at } : null,
      step8ProofAt,
      lastHandshakeAt,
      runnerReady: ready,
      meterOk: meter ? meter.ok === true : null,
      guardEnforced: guardR.error ? null : guardR.data === true,
      killSwitch: pausedR.error || !pausedR.data ? null : Boolean((pausedR.data as { paused: boolean }).paused),
      emergencyStop: controls ? controls.kill_switch : null,
      codeEnabled: controls ? controls.enabled : null,
      authorization: auth ? { expiresAt: String(auth["expires_at"]) } : null,
    };
    return {
      checkedAt: new Date().toISOString(),
      ...input,
      authorizationDetail: auth
        ? {
            id: String(auth["id"]),
            approvalId: String(auth["approval_id"]),
            createdAt: String(auth["created_at"]),
            expiresAt: String(auth["expires_at"]),
            limits: { dailyUsd: Number(auth["daily_limit_usd"]), perCallUsd: Number(auth["per_call_limit_usd"]), perTaskUsd: Number(auth["per_task_reserve_usd"]) },
          }
        : null,
      permits: installed === true ? ((permitsR.data ?? []) as PermitRow[]) : [],
      gates: autonomyGates(input),
    };
  });

export const authorizeOmniAutonomy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ grantId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    const { resolvedLinkConfig } = await import("./omni-session.server");
    const link = await resolvedLinkConfig();
    if (!link) throw new Error("The OMNI link is off or its settings are invalid in Jackboy, so nothing was authorized.");
    const db = await admin();
    const { data: r, error } = await db.rpc("omni_autonomy_authorization_action", {
      _op: "authorize",
      _actor: context.userId,
      _client: link.clientId,
      _project: link.projectId,
      _step: data.grantId,
      _runner_ready: await runnerReady(),
      _reason: null,
    });
    if (error || !r) throw new Error("OMNI autonomous permission could not be recorded (is the permit service installed?). Nothing changed.");
    return r as { ok: boolean; reasons?: string[]; duplicate?: boolean; id?: string; expiresAt?: string; executionBlockedBy?: string[] };
  });

export const revokeOmniAutonomy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const clientId = process.env["OMNI_LINK_CLIENT_ID"] || "";
    const projectId = process.env["OMNI_LINK_PROJECT_ID"] || "";
    if (!clientId || !projectId) throw new Error("OMNI link client/project settings are missing, so there is nothing to revoke.");
    const db = await admin();
    const { data: r, error } = await db.rpc("omni_autonomy_authorization_action", {
      _op: "revoke",
      _actor: context.userId,
      _client: clientId,
      _project: projectId,
      _step: null,
      _runner_ready: null,
      _reason: "revoked by owner in Jackboy",
    });
    if (error || !r) throw new Error("Revocation could not be recorded. OMNI still cannot run while the Emergency Stop is engaged.");
    return r as { ok: boolean; revokedAuthorizations: number; revokedPermits: number };
  });

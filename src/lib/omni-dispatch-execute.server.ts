import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
import { dispatchPayloadDigest } from "./omni-dispatch-digest";
import { logSiteStrict } from "./site-log.server";
import { isOmniVerified } from "./omni-link.server";
import { wireKind } from "./omni-handoff-auth";
import { allowedOmniRepos } from "./omni-jobs";
import { v3ExpiresAt, v3Payload, v3SafetyGate, type DispatchVersion } from "./omni-dispatch-v3";

const grantSchema = z.object({
  valid: z.literal(true),
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
  repo: z.string(),
  kind: z.enum(["code", "test"]),
  instructions: z.string(),
  expiresAt: z.string().optional(),
});

type Db = ReturnType<typeof untyped>;

/** v3 only: Kill Switch, Emergency Stop, spending limits and the Guardian repo list, read fresh. */
async function v3Safety(db: Db, repo: string) {
  const [policy, controls, usage] = await Promise.all([
    db.from("automation_policy").select("paused").eq("id", 1).maybeSingle(),
    db
      .from("code_runtime_controls")
      .select("kill_switch,usage_spike,consecutive_failures,daily_spend_limit_usd")
      .eq("singleton", true)
      .maybeSingle(),
    db
      .from("code_usage_events")
      .select("cost_usd")
      .gte("occurred_at", `${new Date().toISOString().slice(0, 10)}T00:00:00Z`),
  ]);
  const paused =
    !policy.error && typeof (policy.data as { paused?: unknown } | null)?.paused === "boolean"
      ? ((policy.data as { paused: boolean }).paused)
      : null;
  const rows = usage.error ? null : ((usage.data as { cost_usd: number | string | null }[]) ?? []);
  const todaySpendUsd = rows ? rows.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0) : null;
  const reason = v3SafetyGate({
    paused,
    controls: controls.error ? null : ((controls.data as never) ?? null),
    todaySpendUsd,
    allowedRepos: allowedOmniRepos(process.env["OMNI_ALLOWED_REPOS"]),
    repo,
  });
  if (reason) throw new Error(reason);
}

/** Sends one owner-approved build/test handoff action. Before the request and again right before
 * transport it re-checks: live link (fresh + current settings), owner/project scope, the project
 * authorization and the job grant (neither revoked nor expired). Any failure stops the send.
 * v3 additionally re-checks Kill Switch, Emergency Stop, spending limits and the repo list, and
 * signs the grant's instructions and expiry into the submit body. */
export async function executeOmniReceipt(
  actor: string,
  jobId: string,
  grantId: string,
  action: "submit" | "status" | "cancel",
  version: DispatchVersion = "v2",
) {
  if (process.env["OMNI_DISPATCH_ENABLED"] !== "true")
    throw new Error("Scoped OMNI dispatch is disabled.");
  if (version !== "v2" && version !== "v3") throw new Error("Invalid dispatch version.");
  const origin = process.env["OMNI_DISPATCH_ORIGIN"];
  const caFile = process.env["OMNI_DISPATCH_CA_FILE"];
  const clientId = process.env["OMNI_DISPATCH_CLIENT_ID"];
  const secret = process.env["OMNI_DISPATCH_HMAC_SECRET"];
  if (!origin || !caFile || !clientId || !secret)
    throw new Error("Scoped OMNI dispatch configuration is incomplete.");
  const db = untyped(supabaseAdmin);
  const load = async () => {
    if (!(await isOmniVerified()))
      throw new Error("OMNI's live link is not verified right now. Check the connection, then try again.");
    const result = await db.rpc("omni_dispatch_grant_action", {
      _op: "check",
      _actor: actor,
      _job: jobId,
      _grant: grantId,
    });
    if (result.error) throw new Error("Dispatch authorization could not be verified.");
    const parsed = grantSchema.safeParse(result.data);
    if (!parsed.success) {
      const reason = (result.data as { reason?: unknown } | null)?.reason;
      throw new Error(`Dispatch grant unavailable${typeof reason === "string" ? ` (${reason})` : ""}.`);
    }
    const grant = parsed.data;
    if (grant.ownerId !== actor || grant.jobId !== jobId || grant.id !== grantId)
      throw new Error("Dispatch grant scope mismatch.");
    const kind = wireKind(grant.kind);
    const payloadDigest = await dispatchPayloadDigest({ ...grant, kind, grantId: grant.id });
    const scope = {
      ownerId: grant.ownerId,
      projectId: grant.projectId,
      jobId: grant.jobId,
      grantId: grant.id,
      repo: grant.repo,
      kind,
      payloadDigest,
    };
    if (version === "v2") return scope;
    await v3Safety(db, grant.repo);
    if (!grant.expiresAt) throw new Error("The approval's expiry could not be read.");
    return {
      ...scope,
      payload: v3Payload(grant.instructions),
      expiresAt: v3ExpiresAt(grant.expiresAt),
    };
  };
  const scope = await load();
  const { readFile } = await import("node:fs/promises");
  const { OmniDispatchClient } = await import("./omni-dispatch-client.server");
  const client = new OmniDispatchClient(
    { origin, ca: await readFile(caFile), clientId, secret },
    async (candidate) => {
      const current = await load();
      return Object.keys(current).every(
        (key) => current[key as keyof typeof current] === candidate[key as keyof typeof candidate],
      );
    },
    async (event, current) => {
      if (event.startsWith("request_")) {
        await logSiteStrict({
          actor,
          action: "omni.dispatch.request",
          category: "delivery",
          status: "pending",
          summary: `Owner requested ${version === "v3" ? "v3 scoped" : "receive-only"} ${current.kind} ${action}`,
          project_id: current.projectId,
          detail: { jobId, grantId, action, kind: current.kind, contract: version },
        });
        return;
      }
      if (version === "v3") {
        const status = event.slice("result_".length);
        const result = await db.rpc("omni_dispatch_v3_record", {
          _source: "dispatch",
          _nonce: null,
          _owner: current.ownerId,
          _project: current.projectId,
          _job: jobId,
          _grant: grantId,
          _repo: current.repo,
          _status: status,
          _result: null,
        });
        if (result.error || !result.data)
          throw new Error("Receipt could not be recorded; reconcile with the remote owner.");
        return;
      }
      const status = event === "result_cancelled" ? "cancelled" : "quarantined";
      const result = await db.rpc("omni_dispatch_grant_action", {
        _op: `record_${status}`,
        _actor: actor,
        _job: jobId,
        _grant: grantId,
      });
      if (result.error || !result.data)
        throw new Error("Receipt could not be recorded; reconcile with the remote owner.");
    },
    version,
  );
  return client.send(action, scope);
}

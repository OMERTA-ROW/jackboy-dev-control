import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
import { dispatchPayloadDigest } from "./omni-dispatch-digest";
import { logSiteStrict } from "./site-log.server";

const grantSchema = z.object({
  valid: z.literal(true),
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
  repo: z.string(),
  kind: z.literal("test"),
  instructions: z.string(),
});

export async function executeOmniReceipt(
  actor: string,
  jobId: string,
  grantId: string,
  action: "submit" | "status" | "cancel",
) {
  if (process.env["OMNI_DISPATCH_ENABLED"] !== "true")
    throw new Error("Scoped OMNI dispatch is disabled.");
  const origin = process.env["OMNI_DISPATCH_ORIGIN"];
  const caFile = process.env["OMNI_DISPATCH_CA_FILE"];
  const clientId = process.env["OMNI_DISPATCH_CLIENT_ID"];
  const secret = process.env["OMNI_DISPATCH_HMAC_SECRET"];
  if (!origin || !caFile || !clientId || !secret)
    throw new Error("Scoped OMNI dispatch configuration is incomplete.");
  const db = untyped(supabaseAdmin);
  const load = async () => {
    const result = await db.rpc("omni_dispatch_grant_action", {
      _op: "check",
      _actor: actor,
      _job: jobId,
      _grant: grantId,
    });
    if (result.error) throw new Error("Dispatch authorization could not be verified.");
    const parsed = grantSchema.safeParse(result.data);
    if (!parsed.success) throw new Error("Dispatch grant unavailable.");
    const grant = parsed.data;
    if (grant.ownerId !== actor || grant.jobId !== jobId || grant.id !== grantId)
      throw new Error("Dispatch grant scope mismatch.");
    const payloadDigest = await dispatchPayloadDigest({ ...grant, grantId: grant.id });
    return {
      ownerId: grant.ownerId,
      projectId: grant.projectId,
      jobId: grant.jobId,
      grantId: grant.id,
      repo: grant.repo,
      kind: grant.kind,
      payloadDigest,
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
          summary: `Owner requested receive-only ${action}`,
          project_id: current.projectId,
          detail: { jobId, grantId, action },
        });
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
  );
  return client.send(action, scope);
}

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireOwner(ctx: {
  supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> };
}) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can manage the OMNI link.");
}

export const getOmniLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { isOmniVerified, omniConfigState } = await import("./omni-link.server");
    const [jobs, live] = await Promise.all([
      context.supabase
        .from("omni_jobs")
        .select(
          "id, kind, status, repo, attempts, last_error, sent_at, completed_at, pr_url, created_at, code_request_id, instructions",
        )
        .order("created_at", { ascending: false })
        .limit(25),
      isOmniVerified(context.userId),
    ]);
    if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] === "true") {
      const { cancelRevokedOmniV3Receipts } = await import("./omni-dispatch-v3.server");
      await cancelRevokedOmniV3Receipts(context.userId);
    }
    const { data: conn, error: connError } = await context.supabase
      .from("omni_connection")
      .select("verified_at, last_checked_at, last_error")
      .eq("id", true)
      .maybeSingle();
    if (jobs.error || connError) throw new Error("OMNI connection diagnostics could not be loaded.");
    const { safeOmniDiagnostic, safeOmniPullRequestUrl } = await import("./omni-link");
    return {
      config: omniConfigState(),
      connection: {
        verified: live,
        verified_at: live ? conn?.verified_at ?? null : null,
        last_checked_at: conn?.last_checked_at ?? null,
        last_error: live ? null : safeOmniDiagnostic(conn?.last_error),
      },
      jobs: (jobs.data ?? []).map((j) => ({
        ...j,
        instructions: j.instructions.slice(0, 160),
        last_error: safeOmniDiagnostic(j.last_error),
        pr_url: safeOmniPullRequestUrl(j.pr_url),
      })),
    };
  });

export const runOmniHandshake = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { omniHandshake } = await import("./omni-link.server");
    const result = await omniHandshake(context.userId);
    if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] === "true") {
      const { cancelRevokedOmniV3Receipts } = await import("./omni-dispatch-v3.server");
      await cancelRevokedOmniV3Receipts(context.userId);
    }
    return result;
  });

/** Read-only status of one chat-sent OMNI job (real GET /jackboy/jobs/{id}). */
export const checkOmniJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { jobId: string }) => z.object({ jobId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireOwner(context);
    const { getOmniJob } = await import("./omni-jobs.server");
    return getOmniJob(data.jobId);
  });

/** Read-only check of the reviewed OMNI-initiated link (omni.link/v2, PR #3 design).
 * OMNI calls Jackboy, so Jackboy never calls OMNI here; it never sends work or reads secret values. */
export const probeOmniConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { linkConfig, loadEffectiveApproval } = await import("./omni-session.server");
    const { reverseLinkReport, REVERSE_LINK_VARS } = await import("./omni-link-readiness");
    const { remoteRunnerDiagnostic } = await import("./omni-remote-runner");
    const { withApproval } = await import("./omni-link-approval");
    const approval = await loadEffectiveApproval();
    const env = withApproval(Object.fromEntries(REVERSE_LINK_VARS.map((n) => [n, process.env[n]])), approval);
    const runnerEnv = Object.fromEntries(
      ["OMNI_LINK_REMOTE_RUNNER_ENABLED", "OMNI_LINK_REMOTE_RUNNER_URL", "OMNI_LINK_REMOTE_RUNNER_SECRET"]
        .map((n) => [n, process.env[n]]),
    );
    const db = (await import("./untyped-db")).untyped(
      (await import("@/integrations/supabase/client.server")).supabaseAdmin,
    );
    const { data, error } = await db
      .from("omni_link_sessions")
      .select("expires_at")
      .order("expires_at", { ascending: false })
      .limit(1);
    const rows = (data ?? []) as { expires_at: string }[];
    const report = reverseLinkReport({
      runner: (await import("./omni-runner-mode.server")).runnerMode(),
      env,
      configValid: linkConfig({ approvalId: approval.approvalId, approvalExpiresAt: approval.expiresAt }) !== null,
      storageReady: !error && Array.isArray(data),
      lastSessionAt: rows[0]?.expires_at ?? null,
      runnerDiagnostic: remoteRunnerDiagnostic(runnerEnv),
    });
    return { ...report, error: report.verified ? null : report.missing.join(" · ") };
  });

export const dispatchOmniNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { dispatchOmniJobs } = await import("./omni-link.server");
    return dispatchOmniJobs();
  });

export const approveOmniReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        jobId: z.string().uuid(),
        grantId: z.string().uuid(),
        projectId: z.string().uuid(),
        repo: z.string().max(200),
        instructions: z.string().min(3).max(4000),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireOwner(context);
    const identity = await context.supabase.auth.getUser();
    if (
      identity.error ||
      identity.data.user?.id !== context.userId ||
      !identity.data.user.email_confirmed_at
    )
      throw new Error("A confirmed owner session is required.");
    const { isOmniVerified } = await import("./omni-link.server");
    if (!(await isOmniVerified(context.userId)))
      throw new Error("OMNI's live link is not verified right now. Check the connection, then approve.");
    if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] === "true") {
      const { cancelRevokedOmniV3Receipts } = await import("./omni-dispatch-v3.server");
      await cancelRevokedOmniV3Receipts(context.userId);
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { untyped } = await import("./untyped-db");
    const result = await untyped(supabaseAdmin).rpc("omni_dispatch_issue_reviewed", {
      _actor: context.userId,
      _job: data.jobId,
      _step: data.grantId,
      _project: data.projectId,
      _repo: data.repo,
      _instructions: data.instructions,
    });

    if (result.error || !result.data)
      throw new Error(
        `Handoff approval could not be issued: ${result.error?.message?.slice(0, 160) ?? "no result"}.`,
      );
    const issued = z
      .object({
        id: z.string().uuid(),
        expiresAt: z.string(),
        ownerId: z.string().uuid(),
        projectId: z.string().uuid(),
        jobId: z.string().uuid(),
        repo: z.string(),
        kind: z.enum(["code", "test"]),
        instructions: z.string(),
      })
      .parse(result.data);
    const { dispatchPayloadDigest } = await import("./omni-dispatch-digest");
    const { wireKind } = await import("./omni-handoff-auth");
    const payloadDigest = await dispatchPayloadDigest({
      ...issued,
      kind: wireKind(issued.kind),
      grantId: issued.id,
    });
    return { ...issued, payloadDigest };
  });

export const previewOmniReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ jobId: z.string().uuid() }).strict().parse(input))
  .handler(async ({ context, data }) => {
    await requireOwner(context);
    const identity = await context.supabase.auth.getUser();
    if (
      identity.error ||
      identity.data.user?.id !== context.userId ||
      !identity.data.user.email_confirmed_at
    )
      throw new Error("A confirmed owner session is required.");
    const result = await context.supabase
      .from("omni_jobs")
      .select("id,project_id,repo,kind,instructions,status,code_request_id,sent_at")
      .eq("id", data.jobId)
      .maybeSingle();
    if (result.error || !result.data) throw new Error("Job could not be loaded.");
    const j = result.data;
    if (
      (j.kind !== "test" && j.kind !== "code") ||
      j.status !== "queued" ||
      j.code_request_id ||
      j.sent_at ||
      !j.repo
    )
      throw new Error("Only unsent build or test jobs with a repository can be reviewed.");
    return {
      jobId: j.id,
      projectId: j.project_id,
      repo: j.repo,
      kind: j.kind,
      instructions: j.instructions,
    };
  });

export const revokeOmniReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ jobId: z.string().uuid(), grantId: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireOwner(context);
    const identity = await context.supabase.auth.getUser();
    if (
      identity.error ||
      identity.data.user?.id !== context.userId ||
      !identity.data.user.email_confirmed_at
    )
      throw new Error("A confirmed owner session is required.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { untyped } = await import("./untyped-db");
    const result = await untyped(supabaseAdmin).rpc("omni_dispatch_grant_action", {
      _op: "revoke",
      _actor: context.userId,
      _job: data.jobId,
      _grant: data.grantId,
    });
    if (result.error || !result.data) throw new Error("Receipt grant could not be revoked.");
    if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] === "true") {
      try {
        const { cancelRevokedOmniV3Receipts } = await import("./omni-dispatch-v3.server");
        await cancelRevokedOmniV3Receipts(context.userId);
      } catch {
        throw new Error("Jackboy grant was revoked, but signed OMNI cancellation could not be confirmed.");
      }
    }
    return z.object({ revoked: z.literal(true) }).parse(result.data);
  });

export const loadOmniReceiptGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ jobId: z.string().uuid(), grantId: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireOwner(context);
    const identity = await context.supabase.auth.getUser();
    if (
      identity.error ||
      identity.data.user?.id !== context.userId ||
      !identity.data.user.email_confirmed_at
    )
      throw new Error("A confirmed owner session is required.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { untyped } = await import("./untyped-db");
    const result = await untyped(supabaseAdmin).rpc("omni_dispatch_grant_action", {
      _op: "check",
      _actor: context.userId,
      _job: data.jobId,
      _grant: data.grantId,
    });
    if (result.error) throw new Error("Grant could not be checked.");
    const reason = (result.data as { valid?: boolean; reason?: unknown } | null)?.reason;
    if ((result.data as { valid?: boolean } | null)?.valid === false)
      throw new Error(`This approval can't be used now (${typeof reason === "string" ? reason : "unavailable"}).`);
    const grant = z
      .object({
        valid: z.literal(true),
        id: z.string().uuid(),
        expiresAt: z.string(),
        ownerId: z.string().uuid(),
        projectId: z.string().uuid(),
        jobId: z.string().uuid(),
        repo: z.string(),
        kind: z.enum(["code", "test"]),
        instructions: z.string(),
      })
      .parse(result.data);
    if (grant.ownerId !== context.userId || grant.jobId !== data.jobId || grant.id !== data.grantId)
      throw new Error("Grant scope mismatch.");
    const { dispatchPayloadDigest } = await import("./omni-dispatch-digest");
    return {
      ...grant,
      payloadDigest: await dispatchPayloadDigest({
        ...grant,
        kind: (await import("./omni-handoff-auth")).wireKind(grant.kind),
        grantId: grant.id,
      }),
    };
  });

export const sendOmniReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        jobId: z.string().uuid(),
        grantId: z.string().uuid(),
        action: z.enum(["submit", "status", "cancel"]),
        confirm: z.literal(true),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireOwner(context);
    const identity = await context.supabase.auth.getUser();
    if (
      identity.error ||
      identity.data.user?.id !== context.userId ||
      !identity.data.user.email_confirmed_at
    )
      throw new Error("A confirmed owner session is required.");
    if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] === "true") {
      const { cancelRevokedOmniV3Receipts } = await import("./omni-dispatch-v3.server");
      await cancelRevokedOmniV3Receipts(context.userId);
    }
    const { executeOmniReceipt } = await import("./omni-dispatch-execute.server");
    if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] === "true") {
      const { executeOmniV3Receipt } = await import("./omni-dispatch-v3.server");
      return executeOmniV3Receipt(context.userId, data.jobId, data.grantId, data.action);
    }
    return executeOmniReceipt(context.userId, data.jobId, data.grantId, data.action);
  });

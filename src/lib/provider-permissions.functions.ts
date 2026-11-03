import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  GITHUB_PERMISSION_CATALOG,
  isGitHubPermission,
  permissionIncrease,
  permissionLevel,
} from "./provider-permissions";

type Context = {
  supabase: { rpc: (fn: "my_role") => PromiseLike<{ data: unknown }> };
  userId: string;
};

async function requireOwnerOrAdmin(context: Context) {
  const { data } = await context.supabase.rpc("my_role");
  if (data !== "owner" && data !== "admin")
    throw new Error("Only an owner or administrator can manage provider permissions.");
}

const level = z.enum(["read", "write"]);

export const getProviderPermissionDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwnerOrAdmin(context);
    const supabaseAdmin = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const github = await import("./github-app.server");
    const configured = Boolean(await github.appConfig());
    if (configured) await github.syncInstallations(null);
    const [
      { data: app },
      { data: installations, error: installationError },
      { data: events, error: eventsError },
    ] = await Promise.all([
      supabaseAdmin
        .from("github_app_credentials")
        .select("owner_login,slug")
        .eq("id", "jackboy")
        .maybeSingle(),
      supabaseAdmin
        .from("github_installations")
        .select("account_login,account_type,permissions,verified_at")
        .eq("revoked", false)
        .order("account_login"),
      supabaseAdmin
        .from("provider_permission_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (installationError)
      throw new Error(
        `Could not read GitHub installation permissions: ${installationError.message}`,
      );
    if (eventsError)
      throw new Error(`Could not read the permission audit ledger: ${eventsError.message}`);
    return {
      configured,
      appOwner: app?.owner_login ?? null,
      appSlug: app?.slug ?? null,
      settingsUrl: "https://github.com/settings/apps",
      catalog: GITHUB_PERMISSION_CATALOG,
      installations: (installations ?? []).map((row) => ({
        account: row.account_login,
        accountType: row.account_type,
        permissions: row.permissions as Record<string, string>,
        verifiedAt: row.verified_at,
      })),
      events: events ?? [],
    };
  });

export const requestProviderPermission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z
      .object({
        account: z.string().min(1).max(100),
        permission: z.string().min(1).max(80),
        access: level,
        reason: z.string().trim().min(8).max(500),
      })
      .parse(value),
  )
  .handler(async ({ data, context }) => {
    await requireOwnerOrAdmin(context);
    if (!isGitHubPermission(data.permission))
      throw new Error("That permission is not in Jackboy's supported GitHub App request catalog.");
    const supabaseAdmin = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data: installation, error } = await supabaseAdmin
      .from("github_installations")
      .select("account_login,permissions")
      .eq("account_login", data.account)
      .eq("revoked", false)
      .maybeSingle();
    if (error)
      throw new Error(`Could not verify the selected GitHub installation: ${error.message}`);
    if (!installation) throw new Error("Choose a live GitHub App installation.");
    const current = permissionLevel(
      (installation.permissions as Record<string, unknown>)[data.permission],
    );
    if (!permissionIncrease(current, data.access))
      throw new Error(
        "The requested access must be higher than the permission GitHub currently reports.",
      );
    const requestId = crypto.randomUUID();
    const { error: insertError } = await supabaseAdmin.from("provider_permission_events").insert({
      request_id: requestId,
      provider: "github_app",
      event: "requested",
      target: data.account,
      permission: data.permission,
      before_access: current,
      after_access: data.access,
      reason: data.reason,
      actor: context.userId,
    });
    if (insertError)
      throw new Error(`Could not record the permission request: ${insertError.message}`);
    await (
      await import("./site-log.server")
    ).logSiteStrict({
      actor: context.userId,
      action: "provider_permission_requested",
      category: "approval",
      status: "pending",
      summary: `Requested GitHub App ${data.permission}: ${current} to ${data.access} for ${data.account}.`,
      detail: {
        requestId,
        provider: "github_app",
        permission: data.permission,
        before: current,
        after: data.access,
      },
    });
    return { requestId };
  });

export const decideProviderPermission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z
      .object({
        requestId: z.string().uuid(),
        decision: z.enum(["approve", "deny"]),
        grantId: z.string().uuid().optional(),
      })
      .parse(value),
  )
  .handler(async ({ data, context }) => {
    await requireOwnerOrAdmin(context);
    const supabaseAdmin = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data: rows, error } = await supabaseAdmin
      .from("provider_permission_events")
      .select("*")
      .eq("request_id", data.requestId)
      .order("created_at");
    if (error) throw new Error(`Could not read the permission request: ${error.message}`);
    const request = rows?.find((row) => row.event === "requested");
    if (!request) throw new Error("Permission request not found.");
    if (rows?.some((row) => row.event === "approved" || row.event === "denied"))
      throw new Error("This permission request has already been decided.");
    if (!isGitHubPermission(request.permission))
      throw new Error("Permission request is not supported.");
    if (data.decision === "approve") {
      await (
        await import("./passkey.server")
      ).consumeGrant(
        data.grantId,
        context.userId,
        "privilege_escalation",
        `provider_permission:${data.requestId}`,
      );
    }
    const event = data.decision === "approve" ? "approved" : "denied";
    const { error: insertError } = await supabaseAdmin.from("provider_permission_events").insert({
      request_id: data.requestId,
      provider: "github_app",
      event,
      target: request.target,
      permission: request.permission,
      before_access: request.before_access,
      after_access: request.after_access,
      reason: request.reason,
      actor: context.userId,
    });
    if (insertError)
      throw new Error(
        "This request was already decided or the audit ledger could not record the decision.",
      );
    await (
      await import("./site-log.server")
    ).logSiteStrict({
      actor: context.userId,
      action: `provider_permission_${event}`,
      category: "approval",
      status: event === "approved" ? "ok" : "blocked",
      summary: `${event === "approved" ? "Approved" : "Denied"} GitHub App ${request.permission} permission increase for ${request.target}.`,
      detail: {
        requestId: data.requestId,
        provider: "github_app",
        permission: request.permission,
        access: request.after_access,
      },
    });
    return { decision: event, settingsUrl: "https://github.com/settings/apps" };
  });

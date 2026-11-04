import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function requireOwner(ctx: { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> } }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can set up the GitHub App.");
}

/** Builds the pre-filled manifest + signed state. The browser posts it to GitHub; the owner clicks Create. */
export const startGithubAppManifest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { org: string; origin: string; grantId?: string }) => d)
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "credential_change", "github_app:manifest");
    const { buildManifest, manifestPostUrl } = await import("./github-app-manifest");
    const { signState } = await import("./github-app");
    const secret = process.env["JACKBOY_SIGNING_SECRET"];
    if (!secret) throw new Error("Server signing secret is missing.");
    if (!process.env["GITHUB_APP_ENCRYPTION_KEY"]) throw new Error("Server encryption key is missing.");
    const allowed = ["https://jackboy-dev-control.lovable.app", "https://id-preview--72823346-c174-4e90-9e17-671e197837c5.lovable.app", "https://project--72823346-c174-4e90-9e17-671e197837c5.lovable.app", "https://project--72823346-c174-4e90-9e17-671e197837c5-dev.lovable.app"];
    const origin = allowed.includes(data.origin) ? data.origin : "https://jackboy-dev-control.lovable.app";
    const state = await signState({ u: context.userId, p: null, exp: Date.now() + 30 * 60_000 }, secret);
    return { action: manifestPostUrl(data.org, state), manifest: JSON.stringify(buildManifest(origin, data.org)), origin };
  });

export const githubAppStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { appConfig } = await import("./github-app.server");
    const { installUrl, signState } = await import("./github-app");
    const c = await appConfig().catch(() => null);
    const { data: row } = await supabaseAdmin.from("github_app_credentials").select("slug, owner_login, html_url, created_at").eq("id", "jackboy").maybeSingle();
    const { data: inst } = await supabaseAdmin.from("github_installations").select("installation_id, account_login, repositories, missing_permissions, verified_at").eq("revoked", false);
    const secret = process.env["JACKBOY_SIGNING_SECRET"];
    const install = c && secret ? installUrl(c.slug, await signState({ u: context.userId, p: null, exp: Date.now() + 30 * 60_000 }, secret)) : null;
    const covered = new Set((inst ?? []).flatMap((i) => (i.repositories as string[]).map((x) => x.toLowerCase())));
    const { tokenAllowedFor } = await import("./github-app.server");
    const { data: projects } = await supabaseAdmin.from("owner_projects").select("name, github_repo").not("github_repo", "is", null);
    return {
      created: !!c, source: c?.source ?? null, slug: c?.slug ?? null, owner: row?.owner_login ?? null, appUrl: row?.html_url ?? null, createdAt: row?.created_at ?? null,
      installUrl: install,
      installations: (inst ?? []).map((i) => ({ account: i.account_login, repos: i.repositories as string[], missing: i.missing_permissions as string[], verifiedAt: i.verified_at })),
      repos: (projects ?? []).map((p) => ({ name: p.name, repo: p.github_repo as string, via: c && covered.has(String(p.github_repo).toLowerCase()) ? "app" : process.env["GITHUB_TOKEN"] && tokenAllowedFor(String(p.github_repo)) ? "personal token" : "none" })),
      tokenSet: Boolean(process.env["GITHUB_TOKEN"]),
    };
  });

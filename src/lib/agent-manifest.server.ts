// Live checks feeding Jackboy's agent manifest. Server-only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildJackboyManifest, type Checks } from "./agent-manifest";

export async function jackboyManifest() {
  const githubRepo: Checks["githubRepo"] = { ok: false, usable: 0, ...(process.env["GITHUB_TOKEN"] ? {} : { error: "GitHub token not configured" }) };
  if (process.env["GITHUB_TOKEN"]) {
    try { const ws = await import("./repo-workspace.server"); const r = await ws.listAccessibleRepos(); githubRepo.ok = true; githubRepo.usable = r.filter((x) => x.usable).length; }
    catch (e) { githubRepo.error = (e as Error).message.slice(0, 200); }
  }
  const [sites, actions, subs] = await Promise.all([
    supabaseAdmin.from("owner_projects").select("id", { count: "exact", head: true }).not("site_url", "is", null),
    supabaseAdmin.from("capability_grants").select("status").eq("capability", "github_actions").eq("status", "connected").limit(1),
    supabaseAdmin.from("log_subscriptions").select("target").eq("enabled", true),
  ]);
  const outboxTargets = (subs.data ?? []).filter((s: { target: string }) => process.env[`${s.target.toUpperCase()}_API_URL`] && process.env[`${s.target.toUpperCase()}_API_KEY`]).length;
  const code = await (await import("./code.server")).codeCapability();
  return buildJackboyManifest({
    code,
    ai: Boolean(process.env["LOVABLE_API_KEY"]),
    githubRepo,
    actionsRead: (actions.data ?? []).length > 0,
    projectsWithSite: sites.count ?? 0,
    voiceServer: Boolean(process.env["LOVABLE_API_KEY"]),
    outboxTargets,
    omniVerified: false,
  });
}


import { createFileRoute } from "@tanstack/react-router";

// GitHub App Manifest redirect. Public by necessity (GitHub redirects here with ?code&state). Trusts nothing:
// the signed owner state must verify, the code is one-time and exchanged directly with GitHub, and the private
// key + webhook secret are encrypted before storage. They are never returned to the browser.
export const Route = createFileRoute("/api/public/github/manifest")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const back = (q: Record<string, string>) => Response.redirect(`${url.origin}/settings?${new URLSearchParams(q).toString()}#github-app`, 302);
        const code = url.searchParams.get("code") ?? "";
        const secret = process.env["JACKBOY_SIGNING_SECRET"], encKey = process.env["GITHUB_APP_ENCRYPTION_KEY"];
        if (!secret || !encKey || !/^[A-Za-z0-9_-]{8,100}$/.test(code)) return back({ github_app: "error", reason: "Missing code or server setup." });
        const { verifyState } = await import("@/lib/github-app");
        const state = await verifyState(url.searchParams.get("state") ?? "", secret);
        if (!state) return back({ github_app: "error", reason: "This setup link expired or didn't start in Jackboy. Start again from Settings." });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: role } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", state.u).eq("role", "owner").maybeSingle();
        if (!role) return back({ github_app: "error", reason: "Only the owner can create the GitHub App." });
        const { data: existing } = await supabaseAdmin.from("github_app_credentials").select("slug").eq("id", "jackboy").maybeSingle();
        if (existing) return back({ github_app: "error", reason: `A Jackboy app (${existing.slug}) is already saved. Delete it on GitHub and ask Jackboy to clear it before creating another.` });
        const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json", "User-Agent": "Jackboy", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(15_000) });
        const { logSite } = await import("@/lib/site-log.server");
        if (!r.ok) {
          await logSite({ actor: state.u, action: "capability_verified", category: "error", status: "failed", summary: `GitHub App creation exchange failed (${r.status}).` });
          return back({ github_app: "error", reason: `GitHub refused the setup code (${r.status}). Codes expire after one hour; start again.` });
        }
        const a = (await r.json()) as { id: number; slug: string; html_url: string; owner: { login: string }; pem: string; webhook_secret: string | null; permissions: Record<string, string> };
        const { encryptText } = await import("@/lib/github-app-manifest");
        const { error } = await supabaseAdmin.from("github_app_credentials").insert({
          id: "jackboy", app_id: String(a.id), slug: a.slug, owner_login: a.owner.login, html_url: a.html_url,
          private_key_enc: await encryptText(a.pem, encKey), webhook_secret_enc: a.webhook_secret ? await encryptText(a.webhook_secret, encKey) : null,
          permissions: a.permissions ?? {}, created_by: state.u,
        });
        if (error) return back({ github_app: "error", reason: "Could not save the app securely." });
        await logSite({ actor: state.u, action: "capability_approved", category: "approval", status: "ok", summary: `Owner created GitHub App ${a.slug} on ${a.owner.login}. Next: install it and choose repos.`, detail: { app_id: a.id, permissions: a.permissions } });
        return back({ github_app: "created", slug: a.slug });
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";

// GitHub App "Setup URL" callback. Public by necessity (GitHub redirects here), so it trusts nothing in the
// query: the signed owner state must verify, and the installation is re-read from GitHub with the app's own JWT.
export const Route = createFileRoute("/api/public/github/setup")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const back = (q: Record<string, string>) => Response.redirect(`${url.origin}/chat?${new URLSearchParams(q).toString()}`, 302);
        const id = Number(url.searchParams.get("installation_id"));
        const stateRaw = url.searchParams.get("state") ?? "";
        const secret = process.env["JACKBOY_SIGNING_SECRET"];
        if (!secret || !Number.isSafeInteger(id) || id <= 0) return back({ github: "error", reason: "Missing installation or server signing secret." });
        const { verifyState } = await import("@/lib/github-app");
        const state = await verifyState(stateRaw, secret);
        if (!state) return back({ github: "error", reason: "This install link expired or was not started from Jackboy. Ask Jackboy for a fresh link." });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: role } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", state.u).eq("role", "owner").maybeSingle();
        if (!role) return back({ github: "error", reason: "Only the owner can approve new GitHub access." });
        const { logSite } = await import("@/lib/site-log.server");
        try {
          const { recordInstallation } = await import("@/lib/github-app.server");
          const inst = await recordInstallation(id, state.u);
          await logSite({ actor: state.u, action: "capability_approved", category: "approval", status: inst.missing_permissions.length ? "blocked" : "ok", project_id: state.p, summary: `Guardian: owner installed GitHub App on ${inst.account_login} for ${inst.repositories.length} repo(s). Missing: ${inst.missing_permissions.join(", ") || "none"}.`, detail: { installation_id: id, repositories: inst.repositories, permissions: inst.permissions } });
          let verified = "";
          if (state.p) {
            const { data: p } = await supabaseAdmin.from("owner_projects").select("github_repo").eq("id", state.p).maybeSingle();
            if (p?.github_repo && inst.repositories.includes(p.github_repo)) {
              const ac = await import("@/lib/autoconnect.server");
              await ac.approveCapability("github_repo", state.p, state.u, state.u).catch(() => null);
              const r = await ac.verifyCapability("github_repo", state.p, state.u);
              verified = `${r.status}: ${r.detail} Resumed ${r.resumed} task(s).`;
            } else if (p?.github_repo) verified = `${p.github_repo} was not selected in the installation.`;
          }
          return back({ github: inst.missing_permissions.length ? "partial" : "connected", account: inst.account_login, missing: inst.missing_permissions.join(", "), verified });
        } catch (e) {
          await logSite({ actor: state.u, action: "capability_verified", category: "error", status: "failed", project_id: state.p, summary: `GitHub App install could not be verified: ${(e as Error).message}` });
          return back({ github: "error", reason: (e as Error).message.slice(0, 200) });
        }
      },
    },
  },
});

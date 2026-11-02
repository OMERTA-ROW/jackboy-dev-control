import { createFileRoute } from "@tanstack/react-router";

// GitHub App webhook. Every request must carry a valid X-Hub-Signature-256 from the app's own webhook secret.
// Only installation changes act (re-verify / revoke); other events are acknowledged and logged nowhere sensitive.
export const Route = createFileRoute("/api/public/github/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.text();
        if (body.length > 1_000_000) return new Response("Too large", { status: 413 });
        const { appConfig } = await import("@/lib/github-app.server");
        const c = await appConfig().catch(() => null);
        if (!c?.webhookSecret) return new Response("Not configured", { status: 401 });
        const { verifyWebhookSignature } = await import("@/lib/github-app-manifest");
        if (!(await verifyWebhookSignature(body, request.headers.get("x-hub-signature-256"), c.webhookSecret))) return new Response("Invalid signature", { status: 401 });
        const event = request.headers.get("x-github-event") ?? "";
        let p: { action?: string; installation?: { id?: number } };
        try { p = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }
        const id = Number(p.installation?.id);
        if ((event === "installation" || event === "installation_repositories") && Number.isSafeInteger(id) && id > 0) {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { logSite } = await import("@/lib/site-log.server");
          if (p.action === "deleted" || p.action === "suspend") {
            await supabaseAdmin.from("github_installations").update({ revoked: true, updated_at: new Date().toISOString() }).eq("installation_id", id);
            await logSite({ actor: "github", action: "capability_revoked", category: "approval", status: "ok", summary: `GitHub App installation ${id} was ${p.action === "deleted" ? "removed" : "suspended"} on GitHub.` });
          } else {
            const { data: cred } = await supabaseAdmin.from("github_app_credentials").select("created_by").eq("id", "jackboy").maybeSingle();
            const { recordInstallation } = await import("@/lib/github-app.server");
            const inst = await recordInstallation(id, cred?.created_by ?? "github").catch(() => null);
            if (inst) await logSite({ actor: "github", action: "capability_verified", category: "approval", status: inst.missing_permissions.length ? "blocked" : "ok", summary: `GitHub App on ${inst.account_login} now covers ${inst.repositories.length} repo(s).`, detail: { repositories: inst.repositories } });
          }
        }
        return new Response("ok");
      },
    },
  },
});

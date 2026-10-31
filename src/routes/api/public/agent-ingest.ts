import { createFileRoute } from "@tanstack/react-router";
import { hashProjectToken, isWellFormedProjectToken, priorityScore, validateIngest } from "@/lib/agent-hub";

const MAX_BODY = 16_000;
const PER_MINUTE = 30;

/**
 * Health/feedback ingestion for enrolled projects.
 * Auth: `Authorization: Bearer jbk_…` project-scoped token (scope ingest:write). Write-only; never returns hub data.
 */
export const Route = createFileRoute("/api/public/agent-ingest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const deny = (status: number, error: string) => Response.json({ error }, { status });
        const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!isWellFormedProjectToken(token)) return deny(401, "Missing or malformed token");
        const raw = await request.text();
        if (raw.length > MAX_BODY) return deny(413, "Payload too large");
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return deny(400, "Invalid JSON"); }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: tok } = await supabaseAdmin.from("agent_project_tokens").select("id, project_id, revoked_at")
          .eq("token_hash", await hashProjectToken(token)).maybeSingle();
        if (!tok || tok.revoked_at) return deny(401, "Invalid or revoked token");
        const { data: project } = await supabaseAdmin.from("agent_projects").select("id, enrolled, angeltech_enabled, demontech_enabled").eq("id", tok.project_id).single();
        const audit = (outcome: string, detail: Record<string, unknown>) =>
          supabaseAdmin.from("audit_logs").insert({ actor: null, action: "hub.ingest", outcome, detail: { project: tok.project_id, ...detail } as never });
        if (!project?.enrolled) { await audit("not_enrolled", {}); return deny(403, "Project is not enrolled"); }

        const { count } = await supabaseAdmin.from("agent_reports").select("id", { count: "exact", head: true })
          .eq("project_id", project.id).gte("created_at", new Date(Date.now() - 60_000).toISOString());
        if ((count ?? 0) >= PER_MINUTE) { await audit("rate_limited", {}); return deny(429, "Rate limit exceeded"); }

        const v = validateIngest(body);
        if (!v.ok) { await audit("rejected", { reason: v.reason }); return deny(422, v.reason); }
        const d = v.data;
        if (d.agent === "angeltech" && !project.angeltech_enabled) return deny(403, "AngelTech not enabled for this project");
        if (d.agent === "demontech" && !project.demontech_enabled) { await audit("rejected", { reason: "demontech not authorized" }); return deny(403, "DemonTech not authorized by owner for this project"); }

        if (d.agent_id) {
          // Agent must belong to this project, match the category, and hold an owner-approved passport.
          const { data: ag } = await supabaseAdmin.from("agents").select("id, project_id, category, passport_approved, paused").eq("id", d.agent_id).maybeSingle();
          if (!ag || ag.project_id !== project.id || ag.category !== d.agent) { await audit("rejected", { reason: "agent scope mismatch" }); return deny(403, "Agent not registered to this project/category"); }
          if (!ag.passport_approved || ag.paused) { await audit("rejected", { reason: "passport not approved or agent paused", agent: ag.id }); return deny(403, "Agent passport not approved or agent paused"); }
          await supabaseAdmin.from("agents").update({ last_seen_at: new Date().toISOString(), ...(d.health ? { health: d.health } : {}) }).eq("id", ag.id);
        }
        await supabaseAdmin.from("agent_reports").insert({ agent_id: d.agent_id ?? null, project_id: project.id, agent: d.agent, kind: d.kind, severity: d.severity, title: d.title, detail: d.detail, source_url: d.source_url ?? null, priority: priorityScore(d.severity, d.agent) });
        await supabaseAdmin.from("agent_projects").update({ last_report_at: new Date().toISOString(), ...(d.health ? { health: d.health } : {}) }).eq("id", project.id);
        await supabaseAdmin.from("agent_project_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", tok.id);
        await audit("ok", { agent: d.agent_id ?? null, category: d.agent, kind: d.kind, severity: d.severity });
        return Response.json({ ok: true }, { status: 202 });
      },
    },
  },
});

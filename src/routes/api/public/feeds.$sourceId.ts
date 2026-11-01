import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sha256Hex, tagProjects } from "@/lib/feeds";

// Incoming alerts (Zapier, Firecrawl, etc). Auth: per-source secret token in `x-jackboy-token` header or `?token=`.
const Body = z.object({
  title: z.string().max(300).optional(),
  url: z.string().url().max(1000).optional(),
  summary: z.string().max(5000).optional(),
  description: z.string().max(5000).optional(),
  markdown: z.string().max(20000).optional(),
}).passthrough();

export const Route = createFileRoute("/api/public/feeds/$sourceId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!z.string().uuid().safeParse(params.sourceId).success) return new Response("Not found", { status: 404 });
        const token = request.headers.get("x-jackboy-token") ?? new URL(request.url).searchParams.get("token") ?? "";
        if (!/^jbw_[0-9a-f]{48}$/.test(token)) return new Response("Unauthorized", { status: 401 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: src } = await supabaseAdmin.from("feed_sources").select("id, kind, active, token_hash, project_ids").eq("id", params.sourceId).maybeSingle();
        const hash = await sha256Hex(token);
        if (!src || src.kind !== "webhook" || !src.token_hash || src.token_hash !== hash) return new Response("Unauthorized", { status: 401 });
        if (!src.active) return new Response("Source paused", { status: 409 });
        const raw = await request.text();
        if (raw.length > 100_000) return new Response("Too large", { status: 413 });
        let parsed: z.infer<typeof Body>;
        try { parsed = Body.parse(JSON.parse(raw)); } catch { return new Response("Invalid JSON body", { status: 400 }); }
        const title = (parsed.title ?? "Incoming alert").slice(0, 300);
        const summary = (parsed.summary ?? parsed.description ?? parsed.markdown ?? "").slice(0, 1000);
        const { data: projects } = await supabaseAdmin.from("owner_projects").select("id, name");
        const { error } = await supabaseAdmin.from("feed_items").insert({
          source_id: src.id, dedupe_key: `${src.id}:${await sha256Hex(raw)}`, title, url: parsed.url ?? null, summary,
          published_at: new Date().toISOString(), project_ids: tagProjects(src.project_ids, `${title} ${summary}`, projects ?? []),
        });
        await supabaseAdmin.from("feed_sources").update({ last_checked_at: new Date().toISOString(), last_error: null }).eq("id", src.id);
        return Response.json({ ok: true, duplicate: Boolean(error) });
      },
    },
  },
});

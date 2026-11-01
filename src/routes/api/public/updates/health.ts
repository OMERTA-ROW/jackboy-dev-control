import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const body = z.object({
  project: z.string().regex(/^jbp_[a-f0-9]{32}$/),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/).max(64),
  channel: z.enum(["test", "beta", "live"]),
  device: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
  kind: z.enum(["ok", "error", "crash"]),
  message: z.string().max(500).optional(),
});

// Public: projects post health/error/crash reports. Device IDs are hashed; per-device rate limited; no PII stored beyond a short message.
export const Route = createFileRoute("/api/public/updates/health")({
  server: {
    handlers: {
      OPTIONS: async () => { const { CORS } = await import("@/lib/update-server.server"); return new Response(null, { status: 204, headers: CORS }); },
      POST: async ({ request }) => {
        const s = await import("@/lib/update-server.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const raw = await request.text();
        if (raw.length > 4000) return s.json({ error: "too_large" }, 413);
        let input: unknown; try { input = JSON.parse(raw); } catch { return s.json({ error: "invalid_json" }, 400); }
        const parsed = body.safeParse(input);
        if (!parsed.success) return s.json({ error: "invalid_request" }, 400);
        const d = parsed.data;
        const p = await s.projectByKey(d.project);
        if (!p) return s.json({ error: "unknown_project" }, 404);
        const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${p.id}:${d.device}`));
        const device_hash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, "0")).join("");
        const { count } = await supabaseAdmin.from("health_reports").select("id", { count: "exact", head: true })
          .eq("device_hash", device_hash).gte("created_at", new Date(Date.now() - 3600_000).toISOString());
        if ((count ?? 0) >= 30) return s.json({ error: "rate_limited" }, 429);
        const { data: rel } = await supabaseAdmin.from("releases").select("id").eq("project_id", p.id).eq("channel", d.channel).eq("version", d.version).maybeSingle();
        const { error } = await supabaseAdmin.from("health_reports").insert({ project_id: p.id, release_id: rel?.id ?? null, version: d.version, channel: d.channel, device_hash, kind: d.kind, message: (d.message ?? "").slice(0, 500) });
        if (error) return s.json({ error: "store_failed" }, 500);
        const rolledBack = rel && d.kind !== "ok" ? await s.evaluateRelease(rel.id) : false;
        return s.json({ ok: true, rolled_back: rolledBack });
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const q = z.object({
  project: z.string().regex(/^jbp_[a-f0-9]{32}$/),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/).max(64),
  channel: z.enum(["test", "beta", "live"]),
  device: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

// Public: projects ask "is there an update for X at version Y on channel Z?". Returns only signed release metadata.
export const Route = createFileRoute("/api/public/updates/check")({
  server: {
    handlers: {
      OPTIONS: async () => { const { CORS } = await import("@/lib/update-server.server"); return new Response(null, { status: 204, headers: CORS }); },
      GET: async ({ request }) => {
        const s = await import("@/lib/update-server.server");
        const parsed = q.safeParse(Object.fromEntries(new URL(request.url).searchParams));
        if (!parsed.success) return s.json({ error: "invalid_request" }, 400);
        const p = await s.projectByKey(parsed.data.project);
        if (!p) return s.json({ error: "unknown_project" }, 404);
        if (!(await s.keys())) return s.json({ error: "signing_not_configured" }, 503);
        return s.json(await s.checkForUpdate(p.id, parsed.data.channel, parsed.data.version, parsed.data.device));
      },
    },
  },
});

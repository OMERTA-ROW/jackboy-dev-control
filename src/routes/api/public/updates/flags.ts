import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const q = z.object({
  project: z.string().regex(/^jbp_[a-f0-9]{32}$/),
  channel: z.enum(["test", "beta", "live"]),
  device: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

// Public: signed feature flags for a project/channel, evaluated per device for percentage flags.
export const Route = createFileRoute("/api/public/updates/flags")({
  server: {
    handlers: {
      OPTIONS: async () => { const { CORS } = await import("@/lib/update-server.server"); return new Response(null, { status: 204, headers: CORS }); },
      GET: async ({ request }) => {
        const s = await import("@/lib/update-server.server");
        const parsed = q.safeParse(Object.fromEntries(new URL(request.url).searchParams));
        if (!parsed.success) return s.json({ error: "invalid_request" }, 400);
        const p = await s.projectByKey(parsed.data.project);
        if (!p) return s.json({ error: "unknown_project" }, 404);
        const k = await s.keys();
        if (!k) return s.json({ error: "signing_not_configured" }, 503);
        const payload = { project: parsed.data.project, channel: parsed.data.channel, device: parsed.data.device, flags: await s.flagsFor(p.id, parsed.data.channel, parsed.data.device), issued_at: new Date().toISOString() };
        const { signature } = await s.signPayload(k.privateKey, payload);
        return s.json({ payload, signature });
      },
    },
  },
});

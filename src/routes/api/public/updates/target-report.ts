import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const body = z.object({
  release_id: z.string().uuid(),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/).max(64),
  phase: z.enum(["downloaded", "verified", "installed", "healthy", "failed", "rolled_back"]),
  detail: z.string().max(500).default(""),
  key: z.string().min(8).max(100).regex(/^[A-Za-z0-9:._-]+$/),
});

// Enrolled targets report install/health phases (idempotent by key). A failed health report can trigger automatic rollback.
export const Route = createFileRoute("/api/public/updates/target-report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const s = await import("@/lib/update-server.server");
        const u = await import("@/lib/update-targets.server");
        const t = await u.targetFromRequest(request);
        if (!t) return s.json({ error: "unauthorized" }, 401);
        let input: unknown; try { input = JSON.parse((await request.text()).slice(0, 4000)); } catch { return s.json({ error: "invalid_json" }, 400); }
        const p = body.safeParse(input);
        if (!p.success) return s.json({ error: "invalid_request" }, 400);
        try {
          const r = await u.targetReport(t, p.data);
          return s.json(r, "error" in r ? 404 : 200);
        } catch { return s.json({ error: "store_failed" }, 500); }
      },
    },
  },
});

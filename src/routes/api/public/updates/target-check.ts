import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const body = z.object({ version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/).max(64) });

// Public path, but every call requires an enrolled target's bearer token (hashed server-side). Returns signed manifest + policy decision.
export const Route = createFileRoute("/api/public/updates/target-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const s = await import("@/lib/update-server.server");
        const u = await import("@/lib/update-targets.server");
        const t = await u.targetFromRequest(request);
        if (!t) return s.json({ error: "unauthorized" }, 401);
        let input: unknown; try { input = JSON.parse((await request.text()).slice(0, 2000)); } catch { return s.json({ error: "invalid_json" }, 400); }
        const p = body.safeParse(input);
        if (!p.success) return s.json({ error: "invalid_request" }, 400);
        return s.json(await u.targetCheck(t, p.data.version));
      },
    },
  },
});

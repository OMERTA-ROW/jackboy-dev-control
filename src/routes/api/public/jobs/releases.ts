import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Hourly: health-based auto-rollback and staged rollout increases.
export const Route = createFileRoute("/api/public/jobs/releases")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { runReleaseJob } = await import("@/lib/update-server.server");
        const releases = await runReleaseJob();
        const { autopilotTick } = await import("@/lib/autopilot.server");
        let autopilot: unknown;
        try { autopilot = await autopilotTick(); } catch (e) { autopilot = { error: (e as Error).message }; }
        const { foundryTick } = await import("@/lib/foundry.server");
        let foundry: unknown;
        try { foundry = await foundryTick(); } catch (e) { foundry = { error: (e as Error).message }; }
        const { deliverOutbox } = await import("@/lib/site-log.server");
        let outbox: unknown;
        try { outbox = await deliverOutbox(); } catch (e) { outbox = { error: (e as Error).message }; }
        return Response.json({ releases, autopilot, foundry, outbox });
      },
    },
  },
});

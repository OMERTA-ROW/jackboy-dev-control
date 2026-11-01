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
        return Response.json(await runReleaseJob());
      },
    },
  },
});

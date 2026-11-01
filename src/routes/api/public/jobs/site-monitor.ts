import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Called by the managed scheduler; checks only due, monitored site addresses (with backoff).
export const Route = createFileRoute("/api/public/jobs/site-monitor")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { runDueChecks } = await import("@/lib/site-monitor.server");
        return Response.json(await runDueChecks());
      },
    },
  },
});

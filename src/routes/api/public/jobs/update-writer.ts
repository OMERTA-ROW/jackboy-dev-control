import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Called hourly by the managed scheduler. Per-project frequency, caps and pause are checked inside the run.
export const Route = createFileRoute("/api/public/jobs/update-writer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { runUpdateWriter } = await import("@/lib/update-writer.server");
        const r = await runUpdateWriter({ trigger: "scheduled", actor: null });
        return Response.json({ created: r.created, skipped: r.skipped, errors: r.errors.length });
      },
    },
  },
});

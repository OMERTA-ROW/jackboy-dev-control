import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import { isDue } from "@/lib/update-writer";

// Called hourly by the managed scheduler; runs only when the owner-set frequency says it's due.
export const Route = createFileRoute("/api/public/jobs/update-writer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: s } = await supabaseAdmin.from("update_writer_settings").select("frequency_hours, last_run_at").eq("id", 1).single();
        if (!s || !isDue(s.frequency_hours, s.last_run_at)) return Response.json({ ran: false });
        const { runUpdateWriter } = await import("@/lib/update-writer.server");
        const r = await runUpdateWriter({ trigger: "scheduled", actor: null });
        return Response.json({ ran: true, created: r.created, skipped: r.skipped, errors: r.errors.length });
      },
    },
  },
});

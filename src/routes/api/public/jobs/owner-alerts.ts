import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Called by the managed scheduler every few minutes. Read-only scan for items waiting on the owner,
// push alerts, the morning report when it's due, and merging Undo reverts whose checks passed.
// Nothing here starts, approves or dispatches CODE work.
export const Route = createFileRoute("/api/public/jobs/owner-alerts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const out: Record<string, unknown> = {};
        const step = async (name: string, fn: () => Promise<unknown>) => {
          try { out[name] = await fn(); } catch (e) { out[name] = { error: e instanceof Error ? e.message : String(e) }; }
        };
        await step("undos", async () => (await import("@/lib/code-undo.server")).advanceUndos());
        await step("report", async () => (await import("@/lib/daily-report.server")).runDailyReport());
        await step("collect", async () => (await import("@/lib/owner-alerts.server")).collectAlerts());
        await step("flush", async () => (await import("@/lib/owner-alerts.server")).flushAlerts());
        return Response.json(out);
      },
    },
  },
});

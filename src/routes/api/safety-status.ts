import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/safety-status")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("@/lib/safety-status.server")).handleSafetyStatus(request),
    },
  },
});

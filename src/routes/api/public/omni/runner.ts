import { createFileRoute } from "@tanstack/react-router";
// Runner-only endpoint: 404 unless this host is in runner mode with a valid runner secret.
export const Route = createFileRoute("/api/public/omni/runner")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleRunnerRequest } = await import("@/lib/omni-remote-runner.server");
        return handleRunnerRequest(request);
      },
    },
  },
});

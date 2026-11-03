import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/code/claim")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await import("@/lib/code-runner-auth.server")).handleCodeRunnerClaim(request),
    },
  },
});

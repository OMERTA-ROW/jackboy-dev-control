import { createFileRoute } from "@tanstack/react-router";

// Admission gateway for CODE provider traffic: /api/public/code/provider/v1/{responses,chat/completions}.
export const Route = createFileRoute("/api/public/code/provider/$")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await import("@/lib/code-gateway.server")).handleCodeProviderRequest(request),
    },
  },
});

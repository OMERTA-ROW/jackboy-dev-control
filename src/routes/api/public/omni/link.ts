import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/omni/link")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleOmniLinkRequest } = await import("@/lib/omni-configuration.server");
        return handleOmniLinkRequest(request);
      },
    },
  },
});

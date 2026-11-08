import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/omni/link")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleOmniLink, resolvedLinkConfig } = await import("@/lib/omni-session.server");
        return handleOmniLink(request, await resolvedLinkConfig());
      },
    },
  },
});

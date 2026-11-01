import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleChat } = await import("@/lib/chat.server");
        return handleChat(request);
      },
    },
  },
});

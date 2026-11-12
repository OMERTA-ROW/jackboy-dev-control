import { createFileRoute } from "@tanstack/react-router";

// Evolution Mothership → Jackboy handoff. Off unless JACKBOY_HANDOFF_ENABLED === "true".
// Records an owner-approved held task as a QUEUED Jackboy job only; never sends to OMNI.
export const Route = createFileRoute("/api/public/omni-handoff/v1")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleOmniHandoffV1 } = await import("@/lib/omni-handoff-v1.server");
        return handleOmniHandoffV1(request);
      },
    },
  },
});

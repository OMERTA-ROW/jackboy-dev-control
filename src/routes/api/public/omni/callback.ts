import { createFileRoute } from "@tanstack/react-router";

// Legacy results do not carry a verifiable job-scoped owner/project grant.
export function rejectLegacyOmniCallback() {
  return new Response("Legacy OMNI callbacks are disabled; scoped verification is not available.", {
    status: 410,
    headers: { "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/omni/callback")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.headers.get("x-omni-contract") !== "jackboy.dispatch-callback/v2")
          return rejectLegacyOmniCallback();
        const { handleDispatchCallback } = await import("@/lib/omni-dispatch-callback.server");
        return handleDispatchCallback(request);
      },
    },
  },
});

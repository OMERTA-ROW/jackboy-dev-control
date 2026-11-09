import { createFileRoute } from "@tanstack/react-router";
import { currentBuild } from "@/lib/build-info";

// Public and read-only: reports only the source commit/tree this build was made from, so the
// owner (and Jackboy's readiness check) can prove which version is live. No private data.
export const Route = createFileRoute("/api/public/version")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify({ app: "jackboy", ...currentBuild() }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";

// Owner-authenticated agent manifest (owner-agent.manifest/v1). Other agents (OMNI, Guardian) will read this shape later with their own credentials.
export const Route = createFileRoute("/api/agent/manifest")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { verifyOwner } = await import("@/lib/chat.server");
        if (!(await verifyOwner(request))) return Response.json({ error: "Owner sign-in required." }, { status: 401 });
        const { jackboyManifest } = await import("@/lib/agent-manifest.server");
        return Response.json(await jackboyManifest(), { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});

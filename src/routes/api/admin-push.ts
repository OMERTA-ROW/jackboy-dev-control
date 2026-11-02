// TEMPORARY owner-only file push used for the OMNI Dockerfile task. Removed after use.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/admin-push")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyOwner } = await import("@/lib/chat.server");
        const userId = await verifyOwner(request);
        if (!userId) return Response.json({ error: "Owner sign-in required." }, { status: 401 });
        const body = (await request.json()) as { repo?: string; branch?: string; path?: string; content?: string; message?: string };
        if (!body.repo || !body.branch || !body.path || typeof body.content !== "string" || !body.message) {
          return Response.json({ error: "repo, branch, path, content and message are required." }, { status: 400 });
        }
        const ws = await import("@/lib/repo-workspace.server");
        const repo = await ws.openRepo(body.repo);
        const result = await ws.write(repo, body.branch, body.path, body.content, body.message);
        const { logSite } = await import("@/lib/site-log.server");
        await logSite(userId, "admin.push_file", { repo: repo.full, branch: body.branch, path: body.path, action: result.action, commit: result.commit });
        return Response.json(result);
      },
    },
  },
});

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
        if (body.path === "__debug") {
          const { githubTokenFor } = await import("@/lib/github-app.server");
          const t = await githubTokenFor(body.repo);
          const r = await fetch(`https://api.github.com/repos/${body.repo}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${t?.token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy" } });
          const j = (await r.json()) as Record<string, unknown>;
          return Response.json({ status: r.status, via: t?.via, permissions: j["permissions"], visibility: j["visibility"], private: j["private"] });
        }
        const repo = await ws.openRepo(body.repo);
        const result = await ws.write(repo, body.branch, body.path, body.content, body.message);
        const { logSite } = await import("@/lib/site-log.server");
        await logSite({ actor: `owner:${userId}`, action: "admin.push_file", summary: `${result.action} ${body.path} on ${repo.full}@${body.branch}`, repo: repo.full, branch: body.branch, detail: { path: body.path, action: result.action, commit: result.commit } });
        return Response.json(result);
      },
    },
  },
});

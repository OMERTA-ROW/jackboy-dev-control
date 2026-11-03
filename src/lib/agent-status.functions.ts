// Owner-only Agent Status: every field is measured live; nothing is assumed connected.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AgentStatus = {
  model: { connected: boolean; name: string; detail: string };
  github: { connected: boolean; detail: string; usableRepos: number };
  ci: { readable: boolean; detail: string };
  browserRunner: { connected: false; detail: string };
  notion: { connected: false; detail: string };
  lastEdit: { summary: string; at: string; url: string | null } | null;
  lastTest: { summary: string; at: string } | null;
  openPrs: number;
  queuedApprovals: number;
  memoryEntries: number;
};

export const getAgentStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AgentStatus> => {
    const { data: role } = await context.supabase.rpc("my_role");
    if (role !== "owner") throw new Error("Owner only.");
    const sb = context.supabase;

    const key = process.env["LOVABLE_API_KEY"];
    let model = { connected: false, name: "openai/gpt-6-astra", detail: "AI key missing on the server." };
    if (key) {
      const r = await fetch("https://ai.gateway.lovable.dev/v1/models", { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
      model = r?.ok ? { ...model, connected: true, detail: "AI service reachable." } : { ...model, detail: `AI service check failed (${r?.status ?? "network"}).` };
    }

    let github = { connected: false, detail: "No GitHub App installation and no GITHUB_TOKEN fallback.", usableRepos: 0 };
    let ci = { readable: false, detail: "Needs GitHub connection." };
    const gha = await (await import("./github-app.server")).githubAvailable();
    if (gha.ok) {
      try {
        const ws = await import("./repo-workspace.server");
        const repos = await ws.listAccessibleRepos();
        github = { connected: true, detail: gha.via === "app" ? "GitHub App installation active." : "GITHUB_TOKEN fallback valid.", usableRepos: repos.filter((x) => x.usable).length };
        const { data: p } = await sb.from("owner_projects").select("github_repo").not("github_repo", "is", null).limit(1);
        if (p?.[0]?.github_repo) {
          const c = await ws.checks(await ws.openRepo(p[0].github_repo), "main");
          ci = "error" in c && c.error ? { readable: false, detail: "Token lacks Actions: read, so test results can't be read." }
            : { readable: true, detail: c.workflowsConfigured ? `${c.workflowsConfigured} workflow(s).` : "No test workflow in the repo yet." };
        } else ci = { readable: false, detail: "No repo linked yet." };
      } catch (e) { github = { connected: false, detail: (e as Error).message.slice(0, 160), usableRepos: 0 }; }
    }

    const [edit, test, prs, queued, mem] = await Promise.all([
      sb.from("agent_memory").select("summary, created_at, url").eq("kind", "edit").order("created_at", { ascending: false }).limit(1),
      sb.from("agent_memory").select("summary, created_at").eq("kind", "test").order("created_at", { ascending: false }).limit(1),
      sb.from("agent_memory").select("id", { count: "exact", head: true }).eq("kind", "pr"),
      sb.from("update_proposals").select("id", { count: "exact", head: true }).in("status", ["draft", "approved", "pr_open"]),
      sb.from("agent_memory").select("id", { count: "exact", head: true }),
    ]);
    return {
      model, github, ci,
      browserRunner: { connected: false, detail: "No isolated browser runner is connected; JavaScript page tests can't run." },
      notion: { connected: false, detail: "Notion is not connected; memory is stored only in Jackboy." },
      lastEdit: edit.data?.[0] ? { summary: edit.data[0].summary, at: edit.data[0].created_at, url: edit.data[0].url } : null,
      lastTest: test.data?.[0] ? { summary: test.data[0].summary, at: test.data[0].created_at } : null,
      openPrs: prs.count ?? 0, queuedApprovals: queued.count ?? 0, memoryEntries: mem.count ?? 0,
    };
  });

// Owner-only Code Foundry API. Each handler re-checks the owner role before touching the runtime.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function owner(ctx: { supabase: { rpc: (n: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
  return `owner:${ctx.userId}`;
}

export type Connector = { id: string; name: string; state: "connected" | "setup_required" | "error"; scopes: string; detail: string };

export const getFoundry = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    const sb = context.supabase;
    const [tasks, events, patterns, schedule, projects] = await Promise.all([
      sb.from("foundry_tasks").select("id, project_id, title, summary, kind, risk, state, repo, branch, commit_sha, pr_url, pr_number, files, test_evidence, approved_action, attempts, paused, blocked_reason, source, created_at, updated_at").order("updated_at", { ascending: false }).limit(200),
      sb.from("foundry_events").select("id, task_id, project_id, action, actor, from_state, to_state, note, created_at").order("created_at", { ascending: false }).limit(300),
      sb.from("foundry_patterns").select("*").order("verified_count", { ascending: false }),
      sb.from("foundry_schedule").select("*").eq("id", 1).single(),
      sb.from("owner_projects").select("id, name, github_repo").order("name"),
    ]);
    const connectors: Connector[] = [];
    if (process.env["GITHUB_TOKEN"]) {
      try {
        const ws = await import("./repo-workspace.server");
        const r = await ws.listAccessibleRepos();
        connectors.push({ id: "github", name: "GitHub", state: "connected", scopes: "Contents + PRs (private repos with push)", detail: `${r.filter((x) => x.usable).length} usable private repos. Token is a backend secret, revocable on GitHub.` });
      } catch (e) { connectors.push({ id: "github", name: "GitHub", state: "error", scopes: "-", detail: (e as Error).message.slice(0, 160) }); }
    } else connectors.push({ id: "github", name: "GitHub", state: "setup_required", scopes: "-", detail: "Add a fine-grained GitHub token as a backend secret." });
    connectors.push({ id: "notion", name: "Notion", state: process.env["NOTION_API_KEY"] ? "connected" : "setup_required", scopes: process.env["NOTION_API_KEY"] ? "Pages shared with the integration" : "-", detail: process.env["NOTION_API_KEY"] ? "Linked; note sync not yet built." : "Not linked. Notes stay in Jackboy." });
    connectors.push({ id: "google", name: "Google", state: "setup_required", scopes: "-", detail: "No Google connection authorized." });
    connectors.push({ id: "mcp", name: "MCP tools", state: "setup_required", scopes: "-", detail: "No app-side MCP adapter exists; chat-only MCP tools can't be called by the app." });
    connectors.push({ id: "runner", name: "CLI sandbox runner", state: "setup_required", scopes: "-", detail: "No isolated runner connected. Tests come only from GitHub Actions when readable." });
    return { tasks: tasks.data ?? [], events: events.data ?? [], patterns: patterns.data ?? [], schedule: schedule.data, projects: projects.data ?? [], connectors };
  });

export const foundryInspect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { projectId: string }) => ({ projectId: String(d.projectId) }))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const s = await import("./foundry.server");
    return s.inspectProject(data.projectId, actor, "manual", 1);
  });

export const foundryAct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; op: "approve" | "reject" | "pause" | "resume" | "retry"; action?: "open_draft_pr" | "read_checks" }) => d)
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const s = await import("./foundry.server");
    if (data.op === "approve") await s.decide(data.id, actor, "approve", data.action === "read_checks" ? "read_checks" : "open_draft_pr");
    else if (data.op === "reject") await s.decide(data.id, actor, "reject");
    else if (data.op === "pause" || data.op === "resume") await s.setPaused(data.id, actor, data.op === "pause");
    else if (data.op === "retry") await s.retryBlocked(data.id, actor);
    return { ok: true };
  });

export const foundrySchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { enabled: boolean; interval_hours: number; daily_task_quota: number; max_in_flight: number; max_runs_per_day: number }) => {
    const n = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(x) || lo)));
    return { enabled: Boolean(d.enabled), interval_hours: n(d.interval_hours, 1, 720), daily_task_quota: n(d.daily_task_quota, 0, 20), max_in_flight: n(d.max_in_flight, 1, 10), max_runs_per_day: n(d.max_runs_per_day, 1, 200) };
  })
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const s = await import("./foundry.server");
    await s.setSchedule(actor, data);
    return { ok: true };
  });

export const foundryControl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { op: "pause_all" | "resume_all" | "advance" }) => d)
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const s = await import("./foundry.server");
    if (data.op === "advance") return { result: await s.advance(actor) };
    await s.setGlobalPause(actor, data.op === "pause_all");
    return { result: data.op };
  });

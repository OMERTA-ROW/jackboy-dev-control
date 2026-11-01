// Owner-only Code Foundry API. Each handler re-checks the owner role before touching the runtime.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function owner(ctx: { supabase: { rpc: (n: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
  return `owner:${ctx.userId}`;
}

export type Connector = { id: string; name: string; kind: "OAuth" | "API token" | "MCP" | "Runner" | "Webhook"; state: "connected" | "setup_required" | "error"; scopes: string; detail: string; vault: string; revoke: string };

async function connections(): Promise<Connector[]> {
  const has = (k: string) => Boolean(process.env[k]);
  const out: Connector[] = [];
  const gh: Connector = { id: "github", name: "GitHub", kind: "API token", state: "setup_required", scopes: "Needed: Contents read/write, Pull requests read/write, Actions read (private repos only)", detail: "Add a fine-grained GitHub token limited to the repos Jackboy may touch.", vault: "GITHUB_TOKEN (backend secret)", revoke: "Revoke on GitHub → Settings → Developer settings → Tokens; then delete the secret." };
  if (has("GITHUB_TOKEN")) {
    try {
      const ws = await import("./repo-workspace.server");
      const r = await ws.listAccessibleRepos();
      Object.assign(gh, { state: "connected", detail: `${r.filter((x) => x.usable).length} usable private repos (public repos are refused). Actions results are not readable with the current token.` });
    } catch (e) { Object.assign(gh, { state: "error", detail: (e as Error).message.slice(0, 160) }); }
  }
  out.push(gh);
  out.push({ id: "github-webhook", name: "GitHub push webhook", kind: "Webhook", state: has("FOUNDRY_WEBHOOK_SECRET") ? "connected" : "setup_required", scopes: "Push events → one budgeted inspection", detail: has("FOUNDRY_WEBHOOK_SECRET") ? "Signature secret set. Configure the repo webhook to /api/public/foundry/webhook." : "No signature secret; the webhook endpoint rejects every call.", vault: "FOUNDRY_WEBHOOK_SECRET (backend secret)", revoke: "Delete the repo webhook on GitHub and the secret." });
  out.push({ id: "google", name: "Google APIs", kind: "OAuth", state: "setup_required", scopes: "-", detail: "No Google connection authorized.", vault: "-", revoke: "-" });
  out.push({ id: "notion", name: "Notion", kind: "OAuth", state: has("NOTION_API_KEY") ? "connected" : "setup_required", scopes: has("NOTION_API_KEY") ? "Pages shared with the integration" : "-", detail: has("NOTION_API_KEY") ? "Linked; note sync not yet built." : "Not linked. Notes stay in Jackboy.", vault: has("NOTION_API_KEY") ? "NOTION_API_KEY (connector)" : "-", revoke: "Unlink in workspace connectors." });
  out.push({ id: "deploy", name: "Deployment target", kind: "API token", state: "setup_required", scopes: "-", detail: "No deployment connection. Jackboy stops at draft PRs; nothing is deployed.", vault: "-", revoke: "-" });
  out.push({ id: "runner", name: "Browser / CLI sandbox runner", kind: "Runner", state: "setup_required", scopes: "-", detail: "No isolated runner. Tests come only from GitHub Actions when readable.", vault: "-", revoke: "-" });
  out.push({ id: "mcp", name: "MCP tools", kind: "MCP", state: "setup_required", scopes: "-", detail: "No app-side MCP adapter; chat-only MCP tools can't be called by the app.", vault: "-", revoke: "-" });
  return out;
}

export const getConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => { await owner(context as never); return connections(); });

export const getFoundry = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    const sb = context.supabase;
    const [tasks, events, patterns, schedule, projects] = await Promise.all([
      sb.from("foundry_tasks").select("id, project_id, title, summary, kind, risk, state, repo, branch, commit_sha, pr_url, pr_number, files, test_evidence, approved_action, attempts, paused, blocked_reason, source, priority, next_attempt_at, created_at, updated_at").order("updated_at", { ascending: false }).limit(200),
      sb.from("foundry_events").select("id, task_id, project_id, action, actor, from_state, to_state, note, created_at").order("created_at", { ascending: false }).limit(300),
      sb.from("foundry_patterns").select("*").order("verified_count", { ascending: false }),
      sb.from("foundry_schedule").select("*").eq("id", 1).single(),
      sb.from("owner_projects").select("id, name, github_repo").order("name"),
    ]);
    const connectors = await connections();
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

/** Owner-only quality metrics from stored tasks, proposals, releases and installs. */
export const getQualityMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    const sb = context.supabase;
    const [t, p, r, i] = await Promise.all([
      sb.from("foundry_tasks").select("state, test_evidence").limit(2000),
      sb.from("update_proposals").select("status, checks_state, revert_pr_url").limit(2000),
      sb.from("releases").select("status").limit(2000),
      sb.from("update_installs").select("phase").limit(5000),
    ]);
    for (const x of [t, p, r, i]) if (x.error) throw new Error(x.error.message);
    const { qualityMetrics } = await import("./quality-metrics");
    return qualityMetrics({ tasks: t.data ?? [], proposals: p.data ?? [], releases: r.data ?? [], installs: i.data ?? [] });
  });

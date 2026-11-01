// Owner-only Code Foundry API. Each handler re-checks the owner role before touching the runtime.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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
    const [tasks, events, patterns, schedule, projects, packages] = await Promise.all([
      sb.from("foundry_tasks").select("id, project_id, title, summary, kind, risk, state, repo, branch, commit_sha, pr_url, pr_number, files, test_evidence, approved_action, attempts, paused, blocked_reason, source, priority, next_attempt_at, created_at, updated_at").order("updated_at", { ascending: false }).limit(200),
      sb.from("foundry_events").select("id, task_id, project_id, action, actor, from_state, to_state, note, created_at").order("created_at", { ascending: false }).limit(300),
      sb.from("foundry_patterns").select("*").order("verified_count", { ascending: false }),
      sb.from("foundry_schedule").select("*").eq("id", 1).single(),
      sb.from("owner_projects").select("id, name, github_repo").order("name"),
      sb.from("foundry_packages").select("task_id, version, package_sha256, manifest, created_at").order("created_at", { ascending: false }).limit(100),
    ]);
    const connectors = await connections();
    return { tasks: tasks.data ?? [], events: events.data ?? [], patterns: patterns.data ?? [], schedule: schedule.data, projects: projects.data ?? [], packages: packages.data ?? [], connectors };
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
    if (data.op === "approve") throw new Error("Approve through the approval card (it records scope, expiry and a one-time code).");
    if (false as boolean) await s.decide(data.id, actor, "approve", data.action === "read_checks" ? "read_checks" : "open_draft_pr");
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

const sha256 = async (x: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)))).map((b) => b.toString(16).padStart(2, "0")).join("");

/** Create (or re-issue) the approval card for one task action. Returns a fresh single-use nonce; older cards for it stop working. */
export const requestAction = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ taskId: z.string().uuid(), action: z.enum(["open_draft_pr", "read_checks"]) }).parse(d))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const A = await import("./action-approval");
    const { data: t } = await supabaseAdmin.from("foundry_tasks").select("id, project_id, title, risk, state, repo, branch, files").eq("id", data.taskId).single();
    if (!t) throw new Error("Task not found.");
    if (t.state !== "awaiting_approval") throw new Error(`Task is ${t.state}, not awaiting approval.`);
    await supabaseAdmin.from("action_requests").update({ status: "expired" }).eq("status", "pending").lt("expires_at", new Date().toISOString());
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, "0")).join("");
    const nonce_hash = await sha256(nonce);
    const files = (t.files as { path: string; additions?: number; deletions?: number }[]) ?? [];
    const tier = A.classifyTier(data.action, t.risk);
    const expires_at = new Date(Date.now() + A.REQUEST_TTL_MS).toISOString();
    const { data: existing } = await supabaseAdmin.from("action_requests").select("id").eq("task_id", t.id).eq("action", data.action).eq("status", "pending").maybeSingle();
    const res = existing
      ? (await supabaseAdmin.from("action_requests").update({ nonce_hash, expires_at, requested_by: context.userId }).eq("id", existing.id).select("*").single())
      : (await supabaseAdmin.from("action_requests").insert({ project_id: t.project_id, task_id: t.id, action: data.action, tier, nonce_hash, requested_by: context.userId, expires_at,
          resources: { repo: t.repo, branch: t.branch, files: files.map((f) => f.path) } as never, permissions: A.PERMISSIONS[data.action] ?? [],
          diff_summary: files.map((f) => `${f.path} +${f.additions ?? 0}/-${f.deletions ?? 0}`).join("\n").slice(0, 2000), risk: t.risk }).select("*").single());
    const row = res.data;
    if (!row) throw new Error(`Could not create the approval request: ${res.error?.message ?? "unknown"}`);
    const { nonce_hash: _h, ...card } = row;
    return { ...card, nonce, title: t.title };
  });

/** Apply Allow Once / Allow for This Task / Deny. Atomic, single-use, expiring; Critical needs a passkey grant bound to this request. */
export const decideAction = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), nonce: z.string().min(16).max(128), decision: z.enum(["allow_once", "allow_task", "deny"]), grantId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const A = await import("./action-approval");
    const { data: r } = await supabaseAdmin.from("action_requests").select("*").eq("id", data.id).maybeSingle();
    const bad = A.canDecide(r as never, context.userId, data.decision, Boolean(data.grantId));
    if (bad) { if (r?.status === "pending" && /expired/.test(bad)) await supabaseAdmin.from("action_requests").update({ status: "expired" }).eq("id", data.id).eq("status", "pending"); throw new Error(bad); }
    if (r!.tier === "critical" && data.decision !== "deny") await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "critical_change", data.id);
    const allowed = data.decision !== "deny";
    const { data: won } = await supabaseAdmin.from("action_requests").update({ status: allowed ? "allowed" : "denied", mode: data.decision === "allow_task" ? "task" : data.decision === "allow_once" ? "once" : null, decided_by: context.userId, decided_at: new Date().toISOString() })
      .eq("id", data.id).eq("status", "pending").eq("nonce_hash", await sha256(data.nonce)).gt("expires_at", new Date().toISOString()).select("id").maybeSingle();
    if (!won) throw new Error("This card is stale or already used (another tab may have decided it). Refresh.");
    await supabaseAdmin.from("audit_logs").insert({ actor: context.userId, action: `action.${data.decision}`, detail: { request: data.id, task: r!.task_id, action: r!.action, tier: r!.tier } as never, outcome: "ok" });
    const s = await import("./foundry.server");
    let outcome = "denied";
    try {
      if (!allowed) { await s.decide(r!.task_id!, actor, "reject"); }
      else {
        await s.decide(r!.task_id!, actor, "approve", r!.action as "open_draft_pr" | "read_checks");
        // Report what actually happened to the task, never assume success.
        const { data: after } = await supabaseAdmin.from("foundry_tasks").select("state, blocked_reason").eq("id", r!.task_id!).single();
        outcome = after?.state === "completed" ? "completed" : `action_required: ${after?.state ?? "unknown"}${after?.blocked_reason ? ` (${after.blocked_reason})` : ""}`;
      }
    } catch (e) { outcome = `action_required: ${(e as Error).message}`.slice(0, 500); }
    await supabaseAdmin.from("action_requests").update({ outcome }).eq("id", data.id);
    return { status: allowed ? "allowed" : "denied", outcome };
  });

export const listActionRequests = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context as never);
  const { data } = await context.supabase.from("action_requests").select("id, task_id, action, tier, status, mode, outcome, expires_at, decided_at, created_at").order("created_at", { ascending: false }).limit(30);
  return data ?? [];
});

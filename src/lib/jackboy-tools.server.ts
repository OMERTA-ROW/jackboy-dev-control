// Server-only shared Jackboy action set. Text chat, live voice and dashboard buttons call the SAME backend functions.
import { tool } from "ai";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { safeEvidenceUrl, type EvidenceLink } from "./chat-action";

const log = (actor: string, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  supabaseAdmin.from("audit_logs").insert({ actor, action, detail: detail as never, outcome });

async function findProject(name: string) {
  const { data } = await supabaseAdmin.from("owner_projects").select("id, name").ilike("name", `%${name.replace(/[%_]/g, "")}%`).limit(2);
  if (!data?.length) throw new Error(`No project matches "${name}".`);
  if (data.length > 1) throw new Error(`More than one project matches "${name}": ${data.map((d) => d.name).join(", ")}. Be more specific.`);
  return data[0]!;
}


/** All owner tools. Callers must have verified the owner session first and must apply the voice guard for spoken input. */
export function buildJackboyTools(userId: string) {
  const ap = () => import("./autopilot.server");
  const ws = () => import("./repo-workspace.server");
  const projectRepo = async (name: string) => {
    const p = await findProject(name);
    const { data } = await supabaseAdmin.from("owner_projects").select("github_repo").eq("id", p.id).single();
    if (!data?.github_repo) throw new Error(`${p.name} has no GitHub repo linked. Use listRepos, then linkRepo when the owner names the repo.`);
    return (await ws()).openRepo(data.github_repo);
  };
  const remember = async (projectName: string | null, kind: string, summary: string, extra: Record<string, unknown> = {}) => {
    const pid = projectName ? (await findProject(projectName)).id : null;
    await supabaseAdmin.from("agent_memory").insert({ project_id: pid, kind, summary: summary.slice(0, 2000), created_by: userId, ...extra } as never);
  };
  const tools = {
    verifyPermissions: tool({
      description: "Reverify live GitHub contents, PR and Actions permissions for one named project; does not run jobs or change access.",
      inputSchema: z.object({ project: z.string() }),
      execute: async ({ project }) => { const p = await findProject(project); return { project: p.name, ...(await (await import("./project-permissions.server")).checkProjectPermissions(p.id, `owner:${userId}`)) }; },
    }),
    recallMemory: tool({
      description: "Read Jackboy's persistent memory (past inspections, edits, PRs, test results, failures, next actions) for a project, or all projects when null. Call before starting work on a project.",
      inputSchema: z.object({ project: z.string().nullable() }),
      execute: async ({ project }) => {
        let q = supabaseAdmin.from("agent_memory").select("kind, summary, repo, branch, commit_sha, url, created_at, owner_projects(name)").order("created_at", { ascending: false }).limit(30);
        if (project) q = q.eq("project_id", (await findProject(project)).id);
        return (await q).data ?? [];
      },
    }),
    saveMemory: tool({
      description: "Save a note to project memory: an inspection finding, a failure, a fix outcome or the next action. Only record things that actually happened.",
      inputSchema: z.object({ project: z.string().nullable(), kind: z.enum(["inspect", "failure", "fix", "note", "next_action"]), summary: z.string() }),
      execute: async ({ project, kind, summary }) => { await remember(project, kind, summary); return { saved: true }; },
    }),
    capabilities: tool({
      description: "Jackboy's live manifest: what I can do (operational), what's missing (blocked / not built, with the fix) and what I can do next. Call for 'what can you do', 'what's missing', 'what next', and before claiming any ability.",
      inputSchema: z.object({}),
      execute: async () => {
        const m = await (await import("./agent-manifest.server")).jackboyManifest();
        const { missing, nextActions } = await import("./agent-manifest");
        return {
          canDo: m.capabilities.filter((c) => c.status === "operational").map((c) => ({ label: c.label, detail: c.detail, tool: c.tool })),
          missing: missing(m).map((c) => ({ label: c.label, status: c.status, why: c.detail, fix: c.fix })),
          next: nextActions(m),
        };
      },
    }),
    listRepos: tool({
      description: "List GitHub repositories the token can reach; repos (public or private) are usable only where the account has push permission.",
      inputSchema: z.object({}),
      execute: async () => (await ws()).listAccessibleRepos(),
    }),
    linkRepo: tool({
      description: "Link a GitHub repo (owner/repo) to a project. Only when the owner explicitly asks.",
      inputSchema: z.object({ project: z.string(), repo: z.string() }),
      execute: async ({ project, repo }) => {
        const p = await findProject(project);
        const x = await (await ws()).openRepo(repo);
        await supabaseAdmin.from("owner_projects").update({ github_repo: x.full, github_branch: x.base, connect_state: "repo_linked" } as never).eq("id", p.id);
        await log(userId, "workspace.link_repo", { project: p.name, repo: x.full });
        return { project: p.name, repo: x.full, baseBranch: x.base };
      },
    }),
    repoTree: tool({
      description: "List files in the project's repo (optionally filtered by a path substring) on a branch (default: base).",
      inputSchema: z.object({ project: z.string(), filter: z.string().nullable(), branch: z.string().nullable() }),
      execute: async ({ project, filter, branch }) => { const x = await projectRepo(project); return (await ws()).tree(x, branch ?? x.base, filter); },
    }),
    repoSearch: tool({
      description: "Search code in the project's repo (symbols, text).",
      inputSchema: z.object({ project: z.string(), query: z.string().min(2).max(120) }),
      execute: async ({ project, query }) => (await ws()).search(await projectRepo(project), query),
    }),
    readFile: tool({
      description: "Read one file from the project's repo.",
      inputSchema: z.object({ project: z.string(), path: z.string(), branch: z.string().nullable() }),
      execute: async ({ project, path, branch }) => { const x = await projectRepo(project); const f = await (await ws()).read(x, path, branch ?? x.base); return { ...f, content: f.content.slice(0, 60000) }; },
    }),
    writeFile: tool({
      description: "Create/replace (full content) or delete (content null) a file on a jackboy/* work branch. Never the base branch. Read the file first and write the COMPLETE new content.",
      inputSchema: z.object({ project: z.string(), branch: z.string(), path: z.string(), content: z.string().nullable(), message: z.string() }),
      execute: async ({ project, branch, path, content, message }) => {
        const x = await projectRepo(project);
        const r = await (await ws()).write(x, branch, path, content, message);
        await log(userId, "workspace.write", { repo: x.full, branch, path, action: r.action, commit: r.commit });
        await remember(project, "edit", `${r.action} ${path}: ${message}`, { repo: x.full, branch, commit_sha: r.commit });
        return r;
      },
    }),
    showDiff: tool({
      description: "Show the real diff of a jackboy/* branch against the base branch.",
      inputSchema: z.object({ project: z.string(), branch: z.string() }),
      execute: async ({ project, branch }) => (await ws()).diff(await projectRepo(project), branch),
    }),
    openDraftPR: tool({
      description: "Open a draft pull request from a jackboy/* branch for owner review. Never merges.",
      inputSchema: z.object({ project: z.string(), branch: z.string(), title: z.string(), body: z.string() }),
      execute: async ({ project, branch, title, body }) => {
        const x = await projectRepo(project);
        const pr = await (await ws()).openDraftPr(x, branch, title, body);
        await log(userId, "workspace.open_pr", { repo: x.full, branch, pr: pr.url });
        await remember(project, "pr", `Draft PR: ${title}`, { repo: x.full, branch, url: pr.url });
        return pr;
      },
    }),
    checkStatus: tool({
      description: "Read GitHub Actions check results for a branch or commit in the project's repo.",
      inputSchema: z.object({ project: z.string(), ref: z.string() }),
      execute: async ({ project, ref }) => {
        const x = await projectRepo(project); const c = await (await ws()).checks(x, ref);
        await remember(project, "test", "error" in c && c.error ? `Checks unreadable for ${ref}: ${c.error}` : `Checks for ${ref}: ${c.runs.map((r) => `${r.name}=${r.conclusion ?? r.status}`).join(", ") || "none"}`, { repo: x.full, branch: ref });
        return c;
      },
    }),
    projectStatus: tool({
      description: "List all projects with autopilot state, connection state, latest scan and queued/shipped update counts.",
      inputSchema: z.object({}),
      execute: async () => {
        const [{ data: s }, { data: ps }, { data: props }, { data: scans }] = await Promise.all([
          supabaseAdmin.from("update_writer_settings").select("autopilot_enabled, paused_reason").eq("id", 1).single(),
          supabaseAdmin.from("owner_projects").select("id, name, site_url, github_repo, autopilot, connect_state"),
          supabaseAdmin.from("update_proposals").select("project_id, status"),
          supabaseAdmin.from("site_scans").select("project_id, status, findings, created_at").order("created_at", { ascending: false }).limit(100),
        ]);
        return {
          masterAutopilot: s?.autopilot_enabled ?? false, pausedReason: s?.paused_reason ?? null, githubConnected: Boolean(process.env["GITHUB_TOKEN"]),
          projects: (ps ?? []).map((p) => {
            const mine = (props ?? []).filter((x) => x.project_id === p.id);
            const scan = (scans ?? []).find((x) => x.project_id === p.id);
            return { name: p.name, site: p.site_url, repo: p.github_repo, autopilot: p.autopilot, connect: p.connect_state,
              queued: mine.filter((x) => ["draft", "approved", "pr_open"].includes(x.status)).length, shipped: mine.filter((x) => x.status === "merged").length,
              lastScan: scan ? { at: scan.created_at, status: scan.status, findings: (scan.findings as unknown[]).length } : null };
          }),
        };
      },
    }),
    listUpdates: tool({
      description: "List recent update proposals (queued and shipped), optionally for one project.",
      inputSchema: z.object({ project: z.string().nullable() }),
      execute: async ({ project }) => {
        let q = supabaseAdmin.from("update_proposals").select("id, title, status, source, autopilot_note, pr_url, created_at, owner_projects(name)").order("created_at", { ascending: false }).limit(15);
        if (project) q = q.eq("project_id", (await findProject(project)).id);
        const { data } = await q;
        return data ?? [];
      },
    }),
    scanResults: tool({
      description: "Get the latest scan findings for a project.",
      inputSchema: z.object({ project: z.string() }),
      execute: async ({ project }) => {
        const p = await findProject(project);
        const { data } = await supabaseAdmin.from("site_scans").select("id, status, pages_checked, links_checked, avg_ms, findings, error, created_at").eq("project_id", p.id).order("created_at", { ascending: false }).limit(1);
        return data?.[0] ? { project: p.name, ...data[0], findings: (data[0].findings as unknown[]).slice(0, 30) } : { project: p.name, scan: "none yet" };
      },
    }),
    scanSite: tool({
      description: "Scan a project's live site now (pages, broken links, errors, performance, forms).",
      inputSchema: z.object({ project: z.string() }),
      execute: async ({ project }) => {
        const p = await findProject(project);
        await log(userId, "chat.command", { command: "scan", project: p.name });
        const r = await (await ap()).scanSite(p.id, "chat", userId);
        return { project: p.name, pages: r.pages, findings: r.findings.slice(0, 20), total: r.findings.length };
      },
    }),
    fixIssue: tool({
      description: "Write a fix for a described issue on a project. Ships via PR if Autopilot is on for it, otherwise goes to the Update Queue.",
      inputSchema: z.object({ project: z.string(), issue: z.string() }),
      execute: async ({ project, issue }) => {
        const p = await findProject(project);
        await log(userId, "chat.command", { command: "fix", project: p.name, issue: issue.slice(0, 300) });
        return (await ap()).writeFix(p.id, issue, "chat", userId);
      },
    }),
    setAutopilot: tool({
      description: "Turn Autopilot on or off for one project, or the master switch when project is null.",
      inputSchema: z.object({ project: z.string().nullable(), on: z.boolean() }),
      execute: async ({ project, on }) => {
        if (!project) {
          await supabaseAdmin.from("update_writer_settings").update({ autopilot_enabled: on }).eq("id", 1);
          await log(userId, "autopilot.master", { on, via: "chat" });
          return { master: on };
        }
        const p = await findProject(project);
        await supabaseAdmin.from("owner_projects").update({ autopilot: on }).eq("id", p.id);
        await log(userId, "autopilot.project", { project: p.id, name: p.name, on, via: "chat" });
        return { project: p.name, autopilot: on };
      },
    }),
    foundryQueue: tool({
      description: "List Code Foundry tasks (the durable work queue) with state, branch, PR link, test evidence and blocked reason; optionally for one project.",
      inputSchema: z.object({ project: z.string().nullable() }),
      execute: async ({ project }) => {
        let q = supabaseAdmin.from("foundry_tasks").select("id, title, state, risk, branch, pr_url, blocked_reason, test_evidence, updated_at, owner_projects(name)").order("updated_at", { ascending: false }).limit(15);
        if (project) q = q.eq("project_id", (await findProject(project)).id);
        return (await q).data ?? [];
      },
    }),
    foundryInspect: tool({
      description: "Run a real Code Foundry repository inspection for a project (same as the Inspect button): scans the repo, creates deduplicated tasks, prepares low-risk fixes on jackboy/* branches when allowed.",
      inputSchema: z.object({ project: z.string() }),
      execute: async ({ project }) => {
        const p = await findProject(project);
        await log(userId, "chat.command", { command: "foundry_inspect", project: p.name });
        return { project: p.name, ...(await (await import("./foundry.server")).inspectProject(p.id, `owner:${userId}`, "manual", 1)) };
      },
    }),
    foundryDecide: tool({
      description: "Approve (opens a draft PR only; never merges) or reject one Code Foundry task by id (same as the Approve/Reject buttons). Critical tasks still require passkey on the page.",
      inputSchema: z.object({ taskId: z.string().uuid(), decision: z.enum(["approve", "reject"]) }),
      execute: async ({ taskId, decision }) => {
        const { data: t } = await supabaseAdmin.from("foundry_tasks").select("risk").eq("id", taskId).single();
        if (t?.risk === "critical" && decision === "approve") return { blocked: true, reason: "Critical task: approve it on the Code Foundry page with your passkey." };
        await log(userId, "chat.command", { command: "foundry_decide", taskId, decision });
        const r = await (await import("./foundry.server")).decide(taskId, `owner:${userId}`, decision);
        const { data: after } = await supabaseAdmin.from("foundry_tasks").select("state, pr_url, blocked_reason").eq("id", taskId).single();
        return { taskId, result: after ?? r };
      },
    }),
    authorizationHelp: tool({
      description: "When anything is blocked by GitHub 403 / 'Resource not accessible' / missing permission or repo access, call this. Returns the real official authorization destination (GitHub App install link or app-registration page), the exact missing permissions, what Jackboy does automatically, and what the owner must approve. The chat shows the links as buttons; never invent links yourself.",
      inputSchema: z.object({ project: z.string() }),
      execute: async ({ project }) => {
        const p = await findProject(project);
        const [{ data: proj }, { data: g }] = await Promise.all([
          supabaseAdmin.from("owner_projects").select("github_repo").eq("id", p.id).single(),
          supabaseAdmin.from("capability_grants").select("last_error").eq("project_id", p.id).eq("capability", "github_repo").maybeSingle(),
        ]);
        const auth = await (await import("./github-app.server")).githubAuthorization(proj?.github_repo ?? null, userId, p.id, g?.last_error ?? null);
        return { project: p.name, authorizations: [auth] };
      },
    }),
    checkSite: tool({
      description: "Re-check a project's site address now: DNS + HTTPS reachability (same as Check now). Public reachability is not code access.",
      inputSchema: z.object({ project: z.string() }),
      execute: async ({ project }) => {
        const p = await findProject(project);
        const { data } = await supabaseAdmin.from("owner_projects").select("id,site_url,site_fail_count,site_status").eq("id", p.id).single();
        const r = await (await import("./site-monitor.server")).checkAndStore(supabaseAdmin, data as never, `owner:${userId}`);
        return { project: p.name, status: r.status, evidence: r.evidence };
      },
    }),
    connectionStatus: tool({
      description: "Real code-connection state for a project: linked repo, verified GitHub permission grant, last error, background-work switch. Connecting or reconnecting needs the passkey button on the project page.",
      inputSchema: z.object({ project: z.string() }),
      execute: async ({ project }) => {
        const p = await findProject(project);
        const [{ data: proj }, { data: grants }] = await Promise.all([
          supabaseAdmin.from("owner_projects").select("github_repo, dev_enabled, dev_priority, site_url, site_status").eq("id", p.id).single(),
          supabaseAdmin.from("capability_grants").select("id, capability, status, last_error, last_verified_at").eq("project_id", p.id),
        ]);
        return { project: p.name, ...proj, grants: grants ?? [], connectVia: "Project page → Code connection → Connect (passkey)" };
      },
    }),
    setDevEnabled: tool({
      description: "Turn Jackboy's routine background work (scan → repair → test → draft PR) on or off for one project. Sensitive: typed request only.",
      inputSchema: z.object({ project: z.string(), on: z.boolean() }),
      execute: async ({ project, on }) => {
        const p = await findProject(project);
        await supabaseAdmin.from("owner_projects").update({ dev_enabled: on }).eq("id", p.id);
        await log(userId, "projects.dev_enabled", { project: p.name, on, via: "chat" });
        return { project: p.name, backgroundWork: on };
      },
    }),
  };
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute;
    if (!execute) continue;
    (t as { execute: (...args: any[]) => Promise<unknown> }).execute = async (input: Record<string, unknown>, options: any) => {
      try {
        const result = await (execute as (...args: any[]) => Promise<unknown>)(input, options);
        const evidence: EvidenceLink[] = [];
        let project: Awaited<ReturnType<typeof findProject>> | null = null;
        if (typeof input["project"] === "string") project = await findProject(input["project"]);
        if (project) {
          evidence.push({ label: "Open project", url: `/project/${project.id}` });
          const { data: p } = await supabaseAdmin.from("owner_projects").select("github_repo").eq("id", project.id).single();
          if (p?.github_repo) {
            const { githubTokenFor } = await import("./github-app.server"); const auth = await githubTokenFor(p.github_repo);
            if (auth) {
              const r = await fetch(`https://api.github.com/repos/${p.github_repo}`, { headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/vnd.github+json", "User-Agent": "Jackboy" }, signal: AbortSignal.timeout(5000) }).catch(() => null);
              if (r?.ok) evidence.push({ label: "Repository", url: `https://github.com/${p.github_repo}` });
            }
          }
        }
        if (/foundry/i.test(name)) evidence.push({ label: "Work queue", url: "/foundry" });
        if (/Updates|fixIssue|projectStatus/i.test(name)) evidence.push({ label: "Update queue", url: "/updates" });
        if (!evidence.length) evidence.push({ label: "Projects and permissions", url: "/settings" });
        return { result, evidence: evidence.filter((l) => safeEvidenceUrl(l.url)), ...(result && typeof result === "object" && !Array.isArray(result) ? result : {}) };
      } catch (e) {
        await (await import("./credit-pause.server")).recordCreditPause(e);
        return { blocked: true, reason: e instanceof Error ? e.message : "Action failed", evidence: [{ label: "Review blockers and permissions", url: "/settings" }] };
      }
    };
  }
  return tools;
}

/** GuardianPolicy wrapper shared by text and voice: blocked tools return a refusal instead of running. */
export function guardTools(tools: Record<string, any>, userId: string, decide: (name: string) => { allow: boolean; reason?: string }, privileged: string[]) {
  for (const name of privileged) {
    const t = tools[name]; const d = decide(name);
    if (t && !d.allow) { const reason = d.reason; t.execute = async () => { await log(userId, "chat.voice_blocked", { tool: name }, "denied"); return { blocked: true, reason }; }; }
  }
  return tools;
}

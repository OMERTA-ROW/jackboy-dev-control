// Server-only Jackboy chat: owner-verified, tool-calling agent over real project data.
import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PRIVILEGED_TOOLS, privilegedAllowed } from "./voice-guard";
import { createLovableAiGatewayRunIdFetch, getLovableAiGatewayRunId, withLovableAiGatewayRunIdHeader } from "./ai/run-id";

const MODEL = "openai/gpt-6-astra";

export async function verifyOwner(request: Request): Promise<string | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const url = process.env["SUPABASE_URL"]!, key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` }, fetch: (i, init) => { const h = new Headers(init?.headers); h.set("apikey", key); return fetch(i, { ...init, headers: h }); } },
  });
  const { data: u } = await sb.auth.getUser(token);
  if (!u.user) return null;
  const { data: role } = await sb.rpc("my_role");
  return role === "owner" ? u.user.id : null;
}

const log = (actor: string, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  supabaseAdmin.from("audit_logs").insert({ actor, action, detail: detail as never, outcome });

async function findProject(name: string) {
  const { data } = await supabaseAdmin.from("owner_projects").select("id, name").ilike("name", `%${name.replace(/[%_]/g, "")}%`).limit(2);
  if (!data?.length) throw new Error(`No project matches "${name}".`);
  if (data.length > 1) throw new Error(`More than one project matches "${name}": ${data.map((d) => d.name).join(", ")}. Be more specific.`);
  return data[0]!;
}

export async function handleChat(request: Request) {
  const userId = await verifyOwner(request);
  if (!userId) return Response.json({ error: "Owner sign-in required." }, { status: 401 });
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) return Response.json({ error: "AI is not configured on the server." }, { status: 500 });
  const body = (await request.json()) as { messages?: UIMessage[] };
  if (!Array.isArray(body.messages) || body.messages.length > 200) return Response.json({ error: "Invalid messages." }, { status: 400 });

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
      description: "Report exactly which Jackboy capabilities are connected and verified right now. Call this before claiming you can build, edit, test or deploy.",
      inputSchema: z.object({}),
      execute: async () => {
        let github: unknown = "not connected (GITHUB_TOKEN missing)";
        if (process.env["GITHUB_TOKEN"]) { try { const r = await (await ws()).listAccessibleRepos(); github = { connected: true, usablePrivateRepos: r.filter((x) => x.usable).length }; } catch (e) { github = { connected: false, error: (e as Error).message }; } }
        return {
          github,
          canDo: ["list/read/search files in a linked private repo", "write, replace or delete files on a jackboy/* branch", "show the real diff", "open a DRAFT pull request", "read GitHub Actions check results only if the token has Actions: read (use checkStatus; it reports the real error)", "static HTML site scans"],
          cannotDo: ["run code, tests, builds or a terminal inside Jackboy (no sandbox runner connected)", "JavaScript/Playwright browser testing (no isolated browser runner connected)", "merge, deploy or push to the main branch (owner approval only)", "modify its own running server"],
          ciNote: "Automated checks run only if the repository has a GitHub Actions workflow; use checkStatus to see.",
        };
      },
    }),
    listRepos: tool({
      description: "List GitHub repositories the token can reach; only private repos with push access are usable.",
      inputSchema: z.object({}),
      execute: async () => (await ws()).listAccessibleRepos(),
    }),
    linkRepo: tool({
      description: "Link a private GitHub repo (owner/repo) to a project. Only when the owner explicitly asks.",
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
  };

  // Spoken commands never trigger privileged tools on their own: Jackboy must restate and get an explicit "confirm".
  if (!privilegedAllowed(body.messages as never)) {
    for (const name of PRIVILEGED_TOOLS) {
      const t = (tools as Record<string, any>)[name];
      if (t) t.execute = async () => ({ blocked: true, reason: "This request came from voice. Restate exactly what you will do and ask the owner to reply \"confirm\" (typed or spoken) before running it." });
    }
  }
  const runIdFetch = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1", apiKey: key,
    headers: { "Lovable-API-Key": key, "X-Lovable-AIG-SDK": "vercel-ai-sdk" }, fetch: runIdFetch.fetch,
  });
  const result = streamText({
    model: provider.responses(MODEL),
    instructions: [
      "You are Jackboy, the owner's update and repair coordinator. Speak plainly and briefly.",
      "Use tools for every fact about projects, scans, repos and updates — never invent status, results, files, diffs, PRs or releases.",
      "You are a working coding agent ONLY through your repo tools: to change code, use repoTree/repoSearch/readFile, then writeFile on a branch named jackboy/<short-topic>, then showDiff, then openDraftPR. Never paste code into chat as a substitute for writing it, and never claim a change exists unless writeFile returned a commit.",
      "You cannot run code, tests, builds, a terminal or a browser yourself. For checks, use checkStatus (GitHub Actions); if no workflow exists say so plainly. Never say you tested something unless a tool result shows it.",
      "Workflow for any fix: recallMemory -> inspect -> writeFile -> showDiff -> checkStatus -> openDraftPR -> saveMemory (outcome + next_action). Pick low-risk changes; never touch auth, payments, secrets, migrations or permissions without the owner asking.", "Before saying you can build/edit/test anything, call capabilities. Never merge, deploy or write to the base branch; the owner approves pull requests.",
      "Messages from the microphone may be misheard: for any change (scan, fix, write, PR, autopilot, repo link) restate the exact action and wait for the owner to reply \"confirm\". ",
      "Site scans read static HTML only and do not run JavaScript; say so when relevant. Report failures exactly.",
    ].join(" "),
    messages: await convertToModelMessages(body.messages),
    tools,
    stopWhen: stepCountIs(50),
    abortSignal: request.signal,
    providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } },
  });
  return withLovableAiGatewayRunIdHeader(result.toUIMessageStreamResponse({ originalMessages: body.messages, sendReasoning: true }), runIdFetch);
}

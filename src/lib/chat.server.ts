// Server-only Jackboy chat: owner-verified, tool-calling agent over real project data.
import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayRunIdFetch, getLovableAiGatewayRunId, withLovableAiGatewayRunIdHeader } from "./ai/run-id";

const MODEL = "openai/gpt-6-astra";

async function verifyOwner(request: Request): Promise<string | null> {
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
  const tools = {
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

  const runIdFetch = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1", apiKey: key,
    headers: { "Lovable-API-Key": key, "X-Lovable-AIG-SDK": "vercel-ai-sdk" }, fetch: runIdFetch.fetch,
  });
  const result = streamText({
    model: provider.responses(MODEL),
    instructions: [
      "You are Jackboy, the owner's update and repair coordinator. Speak plainly and briefly.",
      "Use tools for every fact about projects, scans and updates — never invent status, results, PRs or releases.",
      "When the owner gives a command (scan, fix, pause/resume autopilot), do it with the matching tool and report the real outcome, including failures.",
      "Explain what you are doing and what happens next. Scans read static HTML only and do not run JavaScript; say so when relevant.",
    ].join(" "),
    messages: await convertToModelMessages(body.messages),
    tools,
    stopWhen: stepCountIs(6),
    abortSignal: request.signal,
    providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } },
  });
  return withLovableAiGatewayRunIdHeader(result.toUIMessageStreamResponse({ originalMessages: body.messages, sendReasoning: true }), runIdFetch);
}

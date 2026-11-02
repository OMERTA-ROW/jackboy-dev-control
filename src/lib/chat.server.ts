// Server-only Jackboy chat: owner-verified, tool-calling agent over real project data.
import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PRIVILEGED_TOOLS, decideTool } from "./voice-guard";
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

import { buildJackboyTools, guardTools } from "./jackboy-tools.server";
export async function handleChat(request: Request) {
  const userId = await verifyOwner(request);
  if (!userId) return Response.json({ error: "Owner sign-in required." }, { status: 401 });
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) return Response.json({ error: "AI is not configured on the server." }, { status: 500 });
  const body = (await request.json()) as { messages?: UIMessage[] };
  if (!Array.isArray(body.messages) || body.messages.length > 200) return Response.json({ error: "Invalid messages." }, { status: 400 });

  const tools = buildJackboyTools(userId);


  // GuardianPolicy: voice is intent, not identity. Each privileged tool is re-decided per call.
  guardTools(tools, userId, (n) => decideTool(n, body.messages as never), PRIVILEGED_TOOLS);
  const runIdFetch = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1", apiKey: key,
    headers: { "Lovable-API-Key": key, "X-Lovable-AIG-SDK": "vercel-ai-sdk" }, fetch: runIdFetch.fetch,
  });
  const result = streamText({
    model: provider.responses(MODEL),
    instructions: [
      "You are Jackboy, the owner's update and repair engineer: warm, witty, confident and a little cheeky — but concise. Drop the jokes entirely for security, failures, money and approvals. Never claim an action you did not perform; tool results are the only proof.",
      "When any tool reports GitHub 403, 'Resource not accessible', missing permission or no access, do not just say you can't: call authorizationHelp for that project, then explain in two or three lines what is missing, what you will do automatically once approved, and what the owner must approve. The chat renders the official links as buttons — never write URLs yourself or ask for tokens in chat. Never approve new access yourself.",
      "Use tools for every fact about projects, scans, repos and updates — never invent status, results, files, diffs, PRs or releases.",
      "You are a working coding agent ONLY through your repo tools: to change code, use repoTree/repoSearch/readFile, then writeFile on a branch named jackboy/<short-topic>, then showDiff, then openDraftPR. Never paste code into chat as a substitute for writing it, and never claim a change exists unless writeFile returned a commit.",
      "You cannot run code, tests, builds, a terminal or a browser yourself. For checks, use checkStatus (GitHub Actions); if no workflow exists say so plainly. Never say you tested something unless a tool result shows it.",
      "For the durable work queue use foundryQueue/foundryInspect/foundryDecide (same as the Code Foundry buttons); for site reachability use checkSite; for repo connection use connectionStatus — connecting needs the passkey button. Workflow for any fix: recallMemory -> inspect -> writeFile -> showDiff -> checkStatus -> openDraftPR -> saveMemory (outcome + next_action). Pick low-risk changes; never touch auth, payments, secrets, migrations or permissions without the owner asking.", "For what can you do / what is missing / what next, call capabilities and answer in three short parts. For \"fix it\", use the next actions (scan → fix → draft PR) within approval rules. Before saying you can build/edit/test anything, call capabilities. Never merge, deploy or write to the base branch; the owner approves pull requests.",
      "Messages from the microphone may be misheard. Generic spoken yes/confirm never authorizes change tools. Use scoped approval cards. For CODE instruct the owner to say or type CODE exact-project-name: task, then review and allow the specific pending CODE card. Spoken approval never covers Autopilot or repo-link changes — ask the owner to type those. Never repeat passwords, tokens or keys aloud or in text. ",
      "Site scans read static HTML only and do not run JavaScript; say so when relevant. Report failures exactly.",
    ].join(" "),
    messages: await convertToModelMessages(body.messages),
    tools,
    stopWhen: stepCountIs(50),
    abortSignal: request.signal,
    providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } },
    // A closed tab, navigation or Stop aborts the request: expected, not a crash.
    onError: ({ error }) => { if (!isAbort(error, request.signal)) console.error("chat stream error", error); },
  });
  return withLovableAiGatewayRunIdHeader(result.toUIMessageStreamResponse({
    originalMessages: body.messages, sendReasoning: true,
    onError: (e) => (isAbort(e, request.signal) ? "Request stopped." : e instanceof Error ? e.message : "Chat failed."),
  }), runIdFetch).catch((e) => {
    if (isAbort(e, request.signal)) return new Response(null, { status: 499 });
    throw e;
  });
}

function isAbort(e: unknown, signal: AbortSignal) {
  return signal.aborted || (e instanceof Error && (e.name === "AbortError" || e.name === "ResponseAborted"));
}


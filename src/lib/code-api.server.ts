import { z } from "zod";
import { verifyOwner } from "./chat.server";
import {
  codeSessionHash,
  codeProjectId,
  requestCode,
  getCode,
  decideCode,
  controlCode,
} from "./code.server";

const input = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("request"),
    project: z.string().trim().min(1).max(120),
    instruction: z.string().trim().min(1).max(2000),
  }),
  z.object({
    op: z.literal("decide"),
    id: z.string().uuid(),
    nonce: z.string().regex(/^[a-f0-9]{48}$/),
    decision: z.enum(["allow", "deny"]),
  }),
  z.object({ op: z.enum(["cancel", "retry"]), id: z.string().uuid() }),
  z.object({ op: z.literal("acceptance"), grantId: z.string().uuid() }),
]);

/** One fixed, docs-only, reviewed-lane request. Fresh owner passkey; gates re-read on the server. */
async function startAcceptance(user: string, session: string, grantId: string) {
  const a = await import("./code-acceptance");
  const { getCodeSafetyState } = await import("./code-safety.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const s = await getCodeSafetyState();
  const pol = await supabaseAdmin.from("automation_policy").select("paused").limit(1).maybeSingle();
  const pinned = s.allowedTargets?.[a.ACCEPTANCE_REPO];
  const blocked = a.acceptanceBlockReason({
    enabled: s.enabled ?? null,
    killSwitch: s.killSwitch ?? null,
    globalPaused: pol.error ? null : (pol.data?.paused ?? null),
    activeRequestId: s.activeRequestId ?? null,
    perTaskReserveUsd: s.perTaskReserveUsd ?? null,
    allowed: pinned?.ref === "main" && !!pinned.workflowSha,
  });
  if (blocked) throw new Error(`Acceptance test blocked: ${blocked}`);
  const open = await supabaseAdmin
    .from("action_requests")
    .select("id")
    .eq("action", "code_workflow")
    .eq("status", "pending")
    .contains("resources", { acceptance: true })
    .limit(1);
  if (open.error || open.data?.length)
    throw new Error("An acceptance test request is already waiting for your decision.");
  await (
    await import("./passkey.server")
  ).consumeGrant(grantId, user, "code_acceptance_test", a.acceptanceTarget(a.ACCEPTANCE_REPO), {
    requireFresh: true,
  });
  return requestCode(
    await codeProjectId(a.ACCEPTANCE_PROJECT),
    a.acceptanceInstruction(new Date()),
    user,
    session,
    false,
    { acceptance: true },
  );
}
export async function handleCode(request: Request): Promise<Response> {
  const reply = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  const user = await verifyOwner(request);
  if (!user) return reply({ error: "Owner sign-in required." }, 401);
  try {
    const token = request.headers.get("authorization")!.replace(/^Bearer\s+/i, "");
    if (request.method === "GET") {
      const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id"));
      return reply(await getCode(id, user));
    }
    if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    // Bound before JSON parsing, including chunked bodies.
    const reader = request.body?.getReader();
    let text = "";
    if (!reader) return reply({ error: "Missing CODE request" }, 400);
    const decoder = new TextDecoder();
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 12_000) {
        await reader.cancel();
        return reply({ error: "CODE request is too large" }, 413);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const data = input.parse(JSON.parse(text));
    const session = codeSessionHash(token);
    if (data.op === "request") {
      return reply(
        await requestCode(await codeProjectId(data.project), data.instruction, user, session),
      );
    }
    if (data.op === "acceptance") return reply(await startAcceptance(user, session, data.grantId));
    if (data.op === "decide")
      return reply(await decideCode(data.id, data.nonce, data.decision, user, session));
    return reply(await controlCode(data.id, data.op, user, session));
  } catch (e) {
    return reply(
      {
        error:
          e instanceof z.ZodError
            ? "Invalid CODE request"
            : e instanceof Error
              ? e.message
              : "CODE request failed",
      },
      400,
    );
  }
}

import { z } from "zod";
import { verifyOwner } from "./chat.server";
import { codeSessionHash, codeProjectId, requestCode, getCode, decideCode, controlCode } from "./code.server";

const input = z.discriminatedUnion("op", [
  z.object({ op: z.literal("request"), project: z.string().trim().min(1).max(120), instruction: z.string().trim().min(1).max(2000) }),
  z.object({ op: z.literal("decide"), id: z.string().uuid(), nonce: z.string().regex(/^[a-f0-9]{48}$/), decision: z.enum(["allow", "deny"]) }),
  z.object({ op: z.enum(["cancel", "retry"]), id: z.string().uuid() }),
]);
export async function handleCode(request: Request): Promise<Response> {
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
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
    const reader = request.body?.getReader(); let text = "";
    if (!reader) return reply({ error: "Missing CODE request" }, 400);
    const decoder = new TextDecoder(); let bytes = 0;
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 12_000) { await reader.cancel(); return reply({ error: "CODE request is too large" }, 413); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode();
    const data = input.parse(JSON.parse(text));
    const session = codeSessionHash(token);
    if (data.op === "request") {
      return reply(await requestCode(await codeProjectId(data.project), data.instruction, user, session));
    }
    if (data.op === "decide") return reply(await decideCode(data.id, data.nonce, data.decision, user, session));
    return reply(await controlCode(data.id, data.op, user, session));
  } catch (e) { return reply({ error: e instanceof z.ZodError ? "Invalid CODE request" : e instanceof Error ? e.message : "CODE request failed" }, 400); }
}

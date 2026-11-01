import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { BATCH_SIZE, parseProposal } from "./update-writer";

const MODEL = "openai/gpt-6-astra";
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "what_to_change", "why", "build_prompt"],
  properties: {
    title: { type: "string" },
    what_to_change: { type: "string" },
    why: { type: "string" },
    build_prompt: { type: "string" },
  },
};

class GatewayError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function generate(p: { name: string; lovable_url: string | null; description: string; goals: string; notes: string }, recent: string[]) {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new GatewayError(401, "AI is not configured on the server.");
  const input = [
    `Project: ${p.name}`, p.lovable_url ? `Link: ${p.lovable_url}` : "", `Description: ${p.description || "(none)"}`,
    `Goals:\n${p.goals || "(none)"}`, `Recent notes:\n${p.notes || "(none)"}`,
    recent.length ? `Recent proposals already written (do not repeat):\n- ${recent.join("\n- ")}` : "",
  ].filter(Boolean).join("\n\n");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": key, Authorization: `Bearer ${key}`, "X-Lovable-AIG-SDK": "fetch" },
    body: JSON.stringify({
      model: MODEL, stream: true, store: false, reasoning: { effort: "low" },
      instructions: "You are Jackboy, an update writer for a software owner. Propose ONE concrete, small, high-value next update that moves the project toward its goals based only on the given description, goals and notes. Never claim anything was tested or deployed. build_prompt must be a ready-to-paste build prompt for an AI app builder (OMNI/Lovable): specific screens, behaviors, data and acceptance checks. Keep secrets out.",
      input,
      text: { format: { type: "json_schema", name: "update_proposal", strict: true, schema: SCHEMA } },
    }),
  });
  if (!res.ok || !res.body) {
    let msg = `AI request failed (${res.status})`;
    try { const j = await res.json() as { message?: string; error?: { message?: string } }; msg = j.message ?? j.error?.message ?? msg; } catch { /* ignore */ }
    throw new GatewayError(res.status, msg);
  }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim(); if (d === "[DONE]") continue;
      try {
        const ev = JSON.parse(d) as { type?: string; delta?: string; error?: { message?: string } };
        if (ev.type === "response.output_text.delta" && ev.delta) text += ev.delta;
        if (ev.type === "response.failed" || ev.type === "error") throw new GatewayError(500, ev.error?.message ?? "AI response failed");
      } catch (e) { if (e instanceof GatewayError) throw e; }
    }
  }
  if (!text.trim()) throw new GatewayError(422, "AI returned no proposal (possibly refused).");
  return parseProposal(text);
}

const audit = (actor: string | null, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  supabaseAdmin.from("audit_logs").insert({ actor, action, detail: detail as never, outcome });

/** Bounded, single-flight run. Caller must already be verified (owner or cron secret). */
export async function runUpdateWriter(opts: { trigger: "manual" | "scheduled"; actor: string | null; projectId?: string }) {
  const now = new Date();
  const { data: s } = await supabaseAdmin.from("update_writer_settings").select("*").eq("id", 1).single();
  if (!s) throw new Error("Settings missing.");
  if (opts.trigger === "scheduled" && s.paused_reason) return { skipped: `paused: ${s.paused_reason}`, created: 0, errors: [] as string[] };
  // Acquire lease (10 min).
  const { data: lock } = await supabaseAdmin.from("update_writer_settings")
    .update({ lock_until: new Date(now.getTime() + 600_000).toISOString() })
    .eq("id", 1).or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`).select("id");
  if (!lock?.length) return { skipped: "another run is in progress", created: 0, errors: [] as string[] };

  let created = 0; const errors: string[] = []; let pause: string | null = null;
  try {
    let q = supabaseAdmin.from("owner_projects").select("*").eq("active", true).order("last_proposal_at", { ascending: true, nullsFirst: true }).limit(BATCH_SIZE);
    if (opts.projectId) q = q.eq("id", opts.projectId);
    const { data: projects } = await q;
    for (const p of projects ?? []) {
      const { data: recent } = await supabaseAdmin.from("update_proposals").select("title").eq("project_id", p.id).order("created_at", { ascending: false }).limit(5);
      try {
        const d = await generate(p, (recent ?? []).map((r) => r.title));
        const { error } = await supabaseAdmin.from("update_proposals").insert({ project_id: p.id, ...d, model: MODEL, trigger: opts.trigger });
        if (error) throw new Error(error.message);
        await supabaseAdmin.from("owner_projects").update({ last_proposal_at: new Date().toISOString() }).eq("id", p.id);
        await audit(opts.actor, "updates.generate", { project: p.id, name: p.name, title: d.title, trigger: opts.trigger });
        created++;
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`${p.name}: ${msg}`);
        await audit(opts.actor, "updates.generate", { project: p.id, name: p.name, error: msg, trigger: opts.trigger }, "error");
        if (e instanceof GatewayError && [401, 402, 403].includes(e.status)) { pause = msg; break; }
        if (e instanceof GatewayError && e.status === 429) break;
      }
    }
  } finally {
    await supabaseAdmin.from("update_writer_settings").update({ lock_until: null, last_run_at: new Date().toISOString(), ...(pause ? { paused_reason: pause } : {}) }).eq("id", 1);
  }
  return { skipped: null, created, errors };
}

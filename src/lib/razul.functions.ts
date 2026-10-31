import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { findingPriority, normalizeFindings, type RazulFinding } from "./razul";

type Ctx = { supabase: any; userId: string };
async function role(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (!data) throw new Error("Forbidden: Jackboy access requires an accepted invitation.");
  return data as "owner" | "admin" | "member";
}
async function manager(ctx: Ctx) {
  if ((await role(ctx)) === "member") throw new Error("Owner or admin only.");
}
const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });

function config() {
  const url = process.env["RAZUL_API_URL"]?.replace(/\/+$/, "");
  const key = process.env["RAZUL_API_KEY"];
  return url && key && /^https:\/\//.test(url) ? { url, key } : null;
}
async function razul(path: string, init: RequestInit = {}) {
  const c = config();
  if (!c) throw new Error("Razul not configured: add RAZUL_API_URL (https) and RAZUL_API_KEY secrets.");
  const res = await fetch(`${c.url}${path}`, { ...init, headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json", Accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!res.ok) throw new Error(`Razul responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export const razulStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await role(context);
    const cfg = config();
    let live = false; let detail = "Not configured — no RAZUL_API_URL / RAZUL_API_KEY secrets.";
    if (cfg) {
      try { await razul("/v1/feed?limit=1"); live = true; detail = "Authenticated feed request succeeded."; }
      catch (e) { detail = (e as Error).message; }
    }
    const [findings, feedback, projects] = await Promise.all([
      context.supabase.from("razul_findings").select("*").order("priority", { ascending: false }).limit(100),
      context.supabase.from("razul_feedback").select("*").order("created_at", { ascending: false }).limit(50),
      context.supabase.from("agent_projects").select("id, name").order("name"),
    ]);
    return { role: r, configured: Boolean(cfg), live, detail, findings: findings.data ?? [], feedback: feedback.data ?? [], projects: projects.data ?? [] };
  });

/** Live search only. Returns nothing (never mock data) when Razul is not configured or unreachable. */
export const searchRazul = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ q: z.string().trim().max(300), mode: z.enum(["search", "feed"]) }).parse(d))
  .handler(async ({ data, context }) => {
    await role(context);
    const path = data.mode === "feed" ? "/v1/feed?limit=25" : `/v1/search?limit=25&q=${encodeURIComponent(data.q)}`;
    try {
      const { findings, dropped } = normalizeFindings(await (await razul(path)).json());
      await audit(context, "razul.query", { mode: data.mode, q: data.q, returned: findings.length, dropped });
      return { findings: findings.map((f) => ({ ...f, priority: findingPriority(f) })), dropped };
    } catch (e) {
      await audit(context, "razul.query", { mode: data.mode, q: data.q, error: (e as Error).message }, "error");
      throw e;
    }
  });

const findingInput = z.custom<RazulFinding>((v) => normalizeFindings([v]).findings.length === 1, "Finding lacks a valid source, timestamp or evidence class.");

export const importFinding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ finding: findingInput }).parse(d))
  .handler(async ({ data, context }) => {
    await manager(context);
    const f = data.finding;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("razul_findings").upsert({
      razul_id: f.id, title: f.title, summary: f.summary, field: f.field, evidence: f.evidence, observed_at: f.observed_at,
      sources: f.sources, confidence: f.confidence ?? null, priority: findingPriority(f), imported_by: context.userId,
    }, { onConflict: "razul_id" });
    if (error) throw new Error(error.message);
    await audit(context, "razul.import", { razul_id: f.id, evidence: f.evidence });
    return { ok: true };
  });

/** Converts a stored finding into a Jackboy proposal or a queued (unsent) OMNI sandbox job for an enrolled project. */
export const routeFinding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), projectId: z.string().uuid(), as: z.enum(["proposal", "research", "sandbox_test"]) }).parse(d))
  .handler(async ({ data, context }) => {
    await manager(context);
    const { data: f } = await context.supabase.from("razul_findings").select("*").eq("id", data.id).single();
    if (!f) throw new Error("Finding not found.");
    const cites = (f.sources as { url: string }[]).map((s) => `- ${s.url}`).join("\n");
    const body = `From RA'SUL finding (${f.evidence}, observed ${f.observed_at}):\n${f.title}\n${f.summary}\nSources:\n${cites}\nEvidence class is Razul's; verify before building. No copying of third-party code without license review.`;
    let error;
    if (data.as === "proposal") {
      ({ error } = await context.supabase.from("agent_proposals").insert({ project_id: data.projectId, title: `[Razul] ${f.title}`.slice(0, 200), summary: body.slice(0, 4000), created_by: context.userId }));
    } else {
      ({ error } = await context.supabase.from("omni_jobs").insert({ project_id: data.projectId, kind: data.as === "research" ? "code" : "test", instructions: `${data.as === "research" ? "Code research" : "Sandbox test"}:\n${body}`.slice(0, 4000), created_by: context.userId }));
    }
    if (error) throw new Error(error.message);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("razul_findings").update({ status: data.as === "proposal" ? "proposed" : "tasked", project_id: data.projectId }).eq("id", data.id);
    await audit(context, "razul.route", { finding: data.id, project: data.projectId, as: data.as, omni_sent: false }, data.as === "proposal" ? "ok" : "queued_not_sent");
    return { ok: true };
  });

/** Records outcome feedback; transmits to Razul only when live, otherwise it stays queued (sent_at null). */
export const sendFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), outcome: z.enum(["useful", "not_relevant", "incorrect", "built", "test_passed", "test_failed"]), note: z.string().trim().max(1000).default("") }).parse(d))
  .handler(async ({ data, context }) => {
    await manager(context);
    const { data: f } = await context.supabase.from("razul_findings").select("razul_id").eq("id", data.id).single();
    if (!f) throw new Error("Finding not found.");
    let sent: string | null = null;
    if (config()) {
      try { await razul("/v1/feedback", { method: "POST", body: JSON.stringify({ finding_id: f.razul_id, outcome: data.outcome, note: data.note }) }); sent = new Date().toISOString(); } catch { /* stays queued */ }
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("razul_feedback").insert({ finding_id: data.id, outcome: data.outcome, note: data.note, sent_at: sent, created_by: context.userId });
    if (error) throw new Error(error.message);
    if (data.outcome === "not_relevant" || data.outcome === "incorrect") await supabaseAdmin.from("razul_findings").update({ status: "dismissed" }).eq("id", data.id);
    await audit(context, "razul.feedback", { finding: data.id, outcome: data.outcome, sent: Boolean(sent) }, sent ? "ok" : "queued_not_sent");
    return { sent: Boolean(sent) };
  });

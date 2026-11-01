// Owner-only site log, export, outbox status, subscriptions and research.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { TARGET_ENV, toCsv, type Target } from "./site-log";

async function owner(ctx: { supabase: { rpc: (n: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
  return `owner:${ctx.userId}`;
}
type Filter = { q?: string | undefined; category?: string | undefined; status?: string | undefined; projectId?: string | undefined; limit?: number | undefined };
const COLS = ["at", "project_id", "actor", "action", "category", "status", "summary", "issue", "source_url", "license", "repo", "branch", "commit_sha", "pr_url", "tests", "task_id"];

function query(sb: Parameters<typeof owner>[0]["supabase"] & { from: any }, f: Filter) {
  let q = sb.from("site_log").select("id, " + COLS.join(", ")).order("at", { ascending: false }).limit(Math.min(1000, f.limit ?? 200));
  if (f.category) q = q.eq("category", f.category);
  if (f.status) q = q.eq("status", f.status);
  if (f.projectId) q = q.eq("project_id", f.projectId);
  if (f.q) { const t = f.q.replace(/[%,()]/g, " ").slice(0, 80); q = q.or(`summary.ilike.%${t}%,action.ilike.%${t}%,pr_url.ilike.%${t}%,repo.ilike.%${t}%`); }
  return q;
}
const clean = (d: Filter): Filter => ({ q: d.q ? String(d.q) : undefined, category: d.category || undefined, status: d.status || undefined, projectId: d.projectId || undefined, limit: Number(d.limit) || undefined });

export const getSiteLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: Filter) => clean(d))
  .handler(async ({ data, context }) => {
    await owner(context as never);
    const sb = context.supabase;
    const [rows, subs, outbox, projects] = await Promise.all([
      query(sb as never, data),
      sb.from("log_subscriptions").select("*"),
      sb.from("log_outbox").select("target, status, last_error, created_at").order("created_at", { ascending: false }).limit(500),
      sb.from("owner_projects").select("id, name").order("name"),
    ]);
    const targets = (Object.keys(TARGET_ENV) as Target[]).map((t) => {
      const sub = subs.data?.find((s) => s.target === t);
      const o = (outbox.data ?? []).filter((x) => x.target === t);
      return { target: t, label: TARGET_ENV[t].label, enabled: !!sub?.enabled, categories: sub?.categories ?? [], configured: !!process.env[TARGET_ENV[t].url] && !!process.env[TARGET_ENV[t].key],
        pending: o.filter((x) => x.status === "pending").length, sent: o.filter((x) => x.status === "sent").length, failed: o.filter((x) => x.status === "failed").length, lastError: o.find((x) => x.last_error)?.last_error ?? null };
    });
    return { rows: (rows.data ?? []) as unknown as Record<string, string | null>[], targets, projects: projects.data ?? [] };
  });

export const exportSiteLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: Filter & { format: "csv" | "json" }) => ({ ...clean(d), format: d.format === "json" ? "json" as const : "csv" as const, limit: 1000 }))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const { data: rows } = await query(context.supabase as never, data);
    const { logSite } = await import("./site-log.server");
    await logSite({ actor, action: "site_log_export", category: "config", summary: `Exported ${rows?.length ?? 0} log entries as ${data.format}.` });
    const r = (rows ?? []) as unknown as Record<string, unknown>[];
    return { body: data.format === "json" ? JSON.stringify(r, null, 2) : toCsv(r, COLS), format: data.format };
  });

export const setSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { target: Target; enabled: boolean }) => ({ target: (["razul", "omni", "jax"].includes(d.target) ? d.target : "razul") as Target, enabled: !!d.enabled }))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("log_subscriptions").update({ enabled: data.enabled, updated_at: new Date().toISOString() }).eq("target", data.target);
    const { logSite } = await import("./site-log.server");
    await logSite({ actor, action: "subscription_changed", category: "config", summary: `${TARGET_ENV[data.target].label} reports ${data.enabled ? "on" : "off"}.` });
    return { ok: true };
  });

export const deliverNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => { await owner(context as never); const s = await import("./site-log.server"); return s.deliverOutbox(); });

export const researchSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { query: string }) => ({ query: String(d.query ?? "").slice(0, 120) }))
  .handler(async ({ data, context }) => { const actor = await owner(context as never); const s = await import("./site-log.server"); return s.researchGitHub(data.query, actor); });

export const researchSave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { hit: { repo: string; path: string; url: string; license: string | null; licenseOk: boolean; stars: number; archived: boolean; pushedAt: string; score: number }; title: string }) => d)
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    if (!/^https:\/\/github\.com\//.test(data.hit.url)) throw new Error("Only GitHub references can be saved.");
    const { licenseAllowed } = await import("./site-log");
    const s = await import("./site-log.server");
    await s.savePattern({ ...data.hit, licenseOk: licenseAllowed(data.hit.license) }, String(data.title), actor);
    return { ok: true };
  });

export const getPatterns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => { await owner(context as never); const { data } = await context.supabase.from("foundry_patterns").select("*").order("score", { ascending: false }).limit(100); return data ?? []; });

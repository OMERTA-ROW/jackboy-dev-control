// Server-only: append to the permanent site log, deliver the outbox, GitHub research.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deliveryBackoffMs, licenseAllowed, redact, scorePattern, TARGET_ENV, type Target } from "./site-log";

export type LogEntry = {
  actor: string; action: string; summary: string;
  category?: "activity" | "inspection" | "patch" | "test" | "approval" | "deployment" | "error" | "rollback" | "research" | "delivery" | "config";
  status?: "info" | "ok" | "pending" | "blocked" | "failed" | "rolled_back";
  project_id?: string | null; issue?: string | null; source_url?: string | null; license?: string | null;
  repo?: string | null; branch?: string | null; commit_sha?: string | null; pr_url?: string | null;
  tests?: string | null; task_id?: string | null; detail?: Record<string, unknown>;
};

export async function logSiteStrict(e: LogEntry) {
  const clean = (v: string | null | undefined) => (v == null ? null : redact(v).slice(0, 2000));
  const detail = JSON.parse(redact(JSON.stringify(e.detail ?? {})).slice(0, 20000) || "{}") as never;
  const { error } = await supabaseAdmin.from("site_log").insert({
    actor: e.actor.slice(0, 120), action: e.action.slice(0, 120), summary: redact(e.summary).slice(0, 2000) || e.action,
    category: e.category ?? "activity", status: e.status ?? "info", project_id: e.project_id ?? null,
    issue: clean(e.issue), source_url: clean(e.source_url), license: clean(e.license), repo: clean(e.repo), branch: clean(e.branch),
    commit_sha: clean(e.commit_sha), pr_url: clean(e.pr_url), tests: clean(e.tests), task_id: e.task_id ?? null, detail,
  });
  if (error) throw new Error(`site_log insert failed: ${error.message}`);
}

export async function logSite(e: LogEntry) {
  try {
    await logSiteStrict(e);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "site_log insert failed");
  }
}

/** Sends due outbox rows. Unconfigured targets stay pending (no fake delivery). Idempotency-Key = outbox id. */
export async function deliverOutbox(limit = 25) {
  const { data: due } = await supabaseAdmin.from("log_outbox").select("id, log_id, target, attempts").eq("status", "pending").lte("next_attempt_at", new Date().toISOString()).order("created_at").limit(limit);
  const out = { sent: 0, waiting: 0, failed: 0 };
  for (const row of due ?? []) {
    const env = TARGET_ENV[row.target as Target];
    const url = env && process.env[env.url], key = env && process.env[env.key];
    if (!url || !key) {
      await supabaseAdmin.from("log_outbox").update({ last_error: `${env?.label ?? row.target} endpoint not configured`, next_attempt_at: new Date(Date.now() + 3600_000).toISOString() }).eq("id", row.id);
      out.waiting++; continue;
    }
    const { data: entry } = await supabaseAdmin.from("site_log").select("*").eq("id", row.log_id).single();
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/jackboy/events`, {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Idempotency-Key": row.id },
        body: JSON.stringify({ contract: "jackboy.site-log/v1", event: entry }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      await supabaseAdmin.from("log_outbox").update({ status: "sent", sent_at: new Date().toISOString(), attempts: row.attempts + 1, last_error: null }).eq("id", row.id);
      out.sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      await supabaseAdmin.from("log_outbox").update({ attempts, last_error: redact((e as Error).message).slice(0, 300), status: attempts >= 8 ? "failed" : "pending", next_attempt_at: new Date(Date.now() + deliveryBackoffMs(attempts)).toISOString() }).eq("id", row.id);
      out.failed++;
    }
  }
  return out;
}

async function gh<T>(path: string): Promise<T> {
  const token = (await (await import("./github-app.server")).anyInstallationToken().catch(() => null)) ?? process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GitHub is not connected.");
  const r = await fetch(`https://api.github.com${path}`, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Jackboy", "X-GitHub-Api-Version": "2022-11-28" } });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

export type ResearchHit = { repo: string; path: string; url: string; license: string | null; licenseOk: boolean; stars: number; archived: boolean; pushedAt: string; score: number };

/** GitHub code search across public repos (official API, rate-limited by GitHub). Returns references only — no code is copied or executed. */
export async function researchGitHub(query: string, actor: string): Promise<ResearchHit[]> {
  const q = query.trim().slice(0, 120);
  if (q.length < 3) throw new Error("Query too short.");
  const s = await gh<{ items: { path: string; html_url: string; repository: { full_name: string; private: boolean } }[] }>(`/search/code?q=${encodeURIComponent(q)}&per_page=15`);
  const items = s.items.filter((i) => !i.repository.private).slice(0, 10);
  const repos = [...new Set(items.map((i) => i.repository.full_name))].slice(0, 8);
  const meta = new Map<string, { license: string | null; stars: number; archived: boolean; pushedAt: string }>();
  for (const r of repos) {
    try {
      const m = await gh<{ license: { spdx_id: string } | null; stargazers_count: number; archived: boolean; pushed_at: string }>(`/repos/${r}`);
      meta.set(r, { license: m.license?.spdx_id && m.license.spdx_id !== "NOASSERTION" ? m.license.spdx_id : null, stars: m.stargazers_count, archived: m.archived, pushedAt: m.pushed_at });
    } catch { /* skip repo */ }
  }
  const terms = q.toLowerCase().split(/\s+/).filter((t) => !t.includes(":"));
  const hits = items.filter((i) => meta.has(i.repository.full_name)).map((i) => {
    const m = meta.get(i.repository.full_name)!;
    const licenseOk = licenseAllowed(m.license);
    return { repo: i.repository.full_name, path: i.path, url: i.html_url, license: m.license, licenseOk, stars: m.stars, archived: m.archived, pushedAt: m.pushedAt,
      score: scorePattern({ licenseOk, archived: m.archived, daysSincePush: (Date.now() - new Date(m.pushedAt).getTime()) / 86400_000, stars: m.stars, pathMatches: terms.some((t) => i.path.toLowerCase().includes(t)) }) };
  }).sort((a, b) => b.score - a.score);
  await logSite({ actor, action: "research_search", category: "research", status: "ok", summary: `GitHub code search "${q}": ${hits.length} referenced results, ${hits.filter((h) => h.licenseOk).length} permissively licensed.`, source_url: "https://docs.github.com/en/rest/search", detail: { query: q, top: hits.slice(0, 3).map((h) => ({ url: h.url, license: h.license, score: h.score })) } });
  return hits;
}

/** Saves a research reference as an unverified pattern candidate (verified_count 0 until a real tested repair uses it). */
export async function savePattern(h: ResearchHit, title: string, actor: string) {
  const key = `gh:${h.repo}:${h.path}`.slice(0, 300);
  const { error } = await supabaseAdmin.from("foundry_patterns").upsert({ key, title: title.slice(0, 200) || h.path, description: `Reference from ${h.repo}. ${h.licenseOk ? "Permissive license: adapt with attribution." : "Not permissively licensed: reference only, do not copy."}`, source_url: h.url, license: h.license, license_ok: h.licenseOk, score: h.score, origin: "github", updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  await logSite({ actor, action: "pattern_saved", category: "research", status: "ok", summary: `Saved pattern candidate "${title}" (${h.license ?? "no license"}, score ${h.score}).`, source_url: h.url, license: h.license });
}

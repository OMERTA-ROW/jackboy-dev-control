// Server-only Autopilot engine: auto-connect PR, live-site scan, AI fixes, auto-ship with staged rollout.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { analyzeHtml, canAutoShip, extractLinks, nextPatch, sortFindings, type Finding } from "./autopilot";
import { safeFetchUrl } from "./feeds";
import { parseRepo } from "./update-writer";
import { audit, callAI, capCheck, deliver, GatewayError, mergeProposal, MODEL, notify, refreshChecks, repoContext, type Project } from "./update-writer.server";
import * as gh from "./github.server";
import { clientSnippet } from "./update-client-snippet";
import { signingKeys, signPayload } from "./update-server";

const JACKBOY_ORIGIN = "https://jackboy-dev-control.lovable.app";
const MAX_PAGES = 12, MAX_LINKS = 30, TIMEOUT = 10_000;

async function settings() {
  const { data } = await supabaseAdmin.from("update_writer_settings").select("autopilot_enabled, monthly_ai_cap, paused_reason").eq("id", 1).single();
  return data!;
}

async function timedFetch(url: string, method = "GET") {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT); const start = Date.now();
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "Jackboy site scanner" } });
    return { res, ms: Date.now() - start, error: null as string | null };
  } catch (e) { return { res: null, ms: Date.now() - start, error: (e as Error).name === "AbortError" ? "timed out" : (e as Error).message }; }
  finally { clearTimeout(t); }
}

/** Crawls same-origin pages (static HTML only; no JavaScript is run) and stores a findings report. */
export async function scanSite(projectId: string, trigger: string, actor: string | null) {
  const { data: p } = await supabaseAdmin.from("owner_projects").select("id, name, site_url").eq("id", projectId).single();
  if (!p?.site_url) throw new Error("This project has no site URL.");
  if (!safeFetchUrl(p.site_url)) throw new Error("Site URL must be a public http(s) address.");
  const { data: scan } = await supabaseAdmin.from("site_scans").insert({ project_id: projectId, trigger }).select("id").single();
  const origin = new URL(p.site_url).origin;
  const findings: Finding[] = []; const queue = [p.site_url]; const seen = new Set<string>(); const links = new Set<string>(); const times: number[] = [];
  try {
    while (queue.length && seen.size < MAX_PAGES) {
      const url = queue.shift()!; if (seen.has(url)) continue; seen.add(url);
      const { res, ms, error } = await timedFetch(url);
      times.push(ms);
      if (!res) { findings.push({ severity: "high", kind: "error", url, message: `Page did not load: ${error}` }); continue; }
      if (res.status >= 400) { findings.push({ severity: "high", kind: "error", url, message: `Page returns HTTP ${res.status}.` }); continue; }
      if (ms > 3000) findings.push({ severity: "medium", kind: "performance", url, message: `Slow response: ${ms} ms.` });
      if (!(res.headers.get("content-type") ?? "").includes("html")) continue;
      const html = (await res.text()).slice(0, 2_000_000);
      findings.push(...analyzeHtml(html, url));
      for (const l of extractLinks(html, url)) {
        if (l.startsWith(origin)) { if (!seen.has(l) && !queue.includes(l)) queue.push(l); }
        else links.add(l);
      }
    }
    for (const l of [...links].slice(0, MAX_LINKS)) {
      if (!safeFetchUrl(l)) continue;
      let { res, error } = await timedFetch(l, "HEAD");
      if (res && (res.status === 405 || res.status === 403)) ({ res, error } = await timedFetch(l));
      if (!res) findings.push({ severity: "medium", kind: "broken_link", url: l, message: `External link unreachable: ${error}` });
      else if (res.status === 404 || res.status === 410 || res.status >= 500) findings.push({ severity: "medium", kind: "broken_link", url: l, message: `External link returns HTTP ${res.status}.` });
    }
    const sorted = sortFindings(findings).slice(0, 200);
    const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
    await supabaseAdmin.from("site_scans").update({ status: "done", findings: sorted as never, pages_checked: seen.size, links_checked: Math.min(links.size, MAX_LINKS), avg_ms: avg, finished_at: new Date().toISOString() }).eq("id", scan!.id);
    await audit(actor, "autopilot.scan", { project: projectId, name: p.name, pages: seen.size, findings: sorted.length, trigger });
    return { scanId: scan!.id as string, findings: sorted, pages: seen.size };
  } catch (e) {
    const msg = (e as Error).message;
    await supabaseAdmin.from("site_scans").update({ status: "failed", error: msg, finished_at: new Date().toISOString() }).eq("id", scan!.id);
    await audit(actor, "autopilot.scan", { project: projectId, name: p.name, error: msg }, "error");
    throw e;
  }
}

/** Writes a fix from findings or error reports. Autopilot on → opens a PR; off → waits in the Update Queue. */
export async function writeFix(projectId: string, problem: string, source: "scan" | "health" | "chat", actor: string | null, scanId?: string) {
  const s = await settings();
  const cap = await capCheck("ai", s.monthly_ai_cap);
  if (cap) throw new Error(cap);
  const { data: p } = await supabaseAdmin.from("owner_projects").select("*").eq("id", projectId).single();
  if (!p) throw new Error("Project not found.");
  let ctx: Awaited<ReturnType<typeof repoContext>> = null; let note = "";
  try { ctx = await repoContext(p as Project); } catch (e) { note = `Repo unavailable: ${(e as Error).message}`; }
  const input = [
    `Project: ${p.name}`, p.site_url ? `Live site: ${p.site_url}` : "", `Goals:\n${p.goals || "(none)"}`,
    `TASK: Fix the most important problems below with the smallest safe change. Focus on bugs, broken pages/links, errors, forms and performance, not new features.`,
    `Problems found (${source}):\n${problem.slice(0, 12000)}`,
    ctx ? `Repository file list (${ctx.paths.length}):\n${ctx.paths.join("\n")}\n\nKey files:\n${ctx.files.join("\n\n")}` : "No repository access: return files as [].",
  ].filter(Boolean).join("\n\n");
  await supabaseAdmin.from("usage_ledger").insert({ kind: "ai", project_id: projectId });
  let d;
  try { d = await callAI(input); }
  catch (e) {
    if (e instanceof GatewayError && [401, 402, 403].includes(e.status)) await supabaseAdmin.from("update_writer_settings").update({ paused_reason: e.message }).eq("id", 1);
    throw e;
  }
  const files = ctx ? d.files : [];
  const auto = s.autopilot_enabled && p.autopilot;
  const { data: row, error } = await supabaseAdmin.from("update_proposals").insert({
    project_id: projectId, title: d.title, what_to_change: d.what_to_change, why: d.why, build_prompt: d.build_prompt,
    files: files as never, model: MODEL, trigger: source === "chat" ? "manual" : "scheduled", source, delivery_error: note || null,
    autopilot_note: auto ? "Autopilot: will ship after checks pass" : "Autopilot off: waiting for your approval",
  }).select("id").single();
  if (error || !row) throw new Error(error?.message ?? "Could not save the fix.");
  if (scanId) await supabaseAdmin.from("site_scans").update({ fix_proposal_id: row.id }).eq("id", scanId);
  await audit(actor, "autopilot.fix_written", { project: projectId, name: p.name, title: d.title, files: files.length, source, autopilot: auto });
  if (auto && files.length) {
    try { await deliver(row.id, actor); } catch (e) { return { id: row.id as string, title: d.title, note: `PR not opened: ${(e as Error).message}` }; }
    return { id: row.id as string, title: d.title, note: "Pull request opened; Autopilot ships it once checks pass." };
  }
  await notify("waiting", `Fix waiting for approval: ${d.title} (${p.name})`, row.id);
  return { id: row.id as string, title: d.title, note: files.length ? "Waiting in the Update Queue for your approval." : "Written as instructions only (no repo access)." };
}

/** Opens a PR adding the update client with this project's key filled in. */
export async function connectProject(projectId: string, actor: string | null) {
  const { data: p } = await supabaseAdmin.from("owner_projects").select("id, name, client_key, github_repo, github_branch").eq("id", projectId).single();
  if (!p) throw new Error("Project not found.");
  const repo = p.github_repo ? parseRepo(p.github_repo) : null;
  const set = (connect_state: string, extra: Record<string, unknown> = {}) => supabaseAdmin.from("owner_projects").update({ connect_state, ...extra }).eq("id", projectId);
  if (!repo) { await set("no_repo"); return { state: "no_repo" }; }
  if (!gh.githubConfigured()) { await set("waiting_github", { connect_error: "GitHub token not added yet." }); return { state: "waiting_github" }; }
  const secret = process.env["JACKBOY_SIGNING_SECRET"];
  const publicKey = secret ? (await signingKeys(secret)).publicKeyBase64 : "PASTE_PUBLIC_KEY";
  try {
    await gh.requirePrivateRepo(repo.owner, repo.repo);
    const branch = `jackboy/connect-${Date.now().toString(36)}`;
    await gh.commitToNewBranch(repo.owner, repo.repo, p.github_branch, branch, "Jackboy: add update client", [{ path: "src/lib/jackboy-updates.ts", content: clientSnippet(JACKBOY_ORIGIN, p.client_key, publicKey) }]);
    const pr = await gh.openPullRequest(repo.owner, repo.repo, branch, p.github_branch, "Jackboy: connect update client",
      "Adds `src/lib/jackboy-updates.ts` with this project's Jackboy client key (a public identifier, not a secret) so it can check for signed updates, fetch feature flags and report errors.\n\nImport it once from your app entry to start error reporting.\n\n_Opened automatically by Jackboy._");
    await set("pr_open", { connect_pr_url: pr.html_url, connect_error: null });
    await audit(actor, "autopilot.connect", { project: projectId, name: p.name, pr: pr.number });
    return { state: "pr_open", url: pr.html_url };
  } catch (e) {
    const msg = (e as Error).message;
    await set("failed", { connect_error: msg });
    await audit(actor, "autopilot.connect", { project: projectId, name: p.name, error: msg }, "error");
    return { state: "failed", error: msg };
  }
}

/** Runs on project creation: connect + scan + fix. Failures are recorded, never hidden. */
export async function onProjectAdded(projectId: string, actor: string) {
  const out: string[] = [];
  const c = await connectProject(projectId, actor); out.push(`connect: ${c.state}`);
  const { data: p } = await supabaseAdmin.from("owner_projects").select("site_url").eq("id", projectId).single();
  if (p?.site_url) {
    try {
      const s = await scanSite(projectId, "on_connect", actor); out.push(`scan: ${s.findings.length} findings on ${s.pages} pages`);
      const serious = s.findings.filter((f) => f.severity !== "low");
      if (serious.length) { const f = await writeFix(projectId, serious.map((x) => `- [${x.severity}] ${x.kind} ${x.url}: ${x.message}`).join("\n"), "scan", actor, s.scanId); out.push(`fix: ${f.note}`); }
    } catch (e) { out.push(`scan/fix: ${(e as Error).message}`); }
  }
  return out;
}

async function publishAutoRelease(projectId: string, createdBy: string, title: string) {
  const secret = process.env["JACKBOY_SIGNING_SECRET"];
  if (!secret) return "no signing key";
  const { data: p } = await supabaseAdmin.from("owner_projects").select("client_key").eq("id", projectId).single();
  const { data: last } = await supabaseAdmin.from("releases").select("version").eq("project_id", projectId).eq("channel", "live").order("created_at", { ascending: false }).limit(1);
  const version = nextPatch(last?.[0]?.version ?? null);
  const published_at = new Date().toISOString();
  const { data: r, error } = await supabaseAdmin.from("releases").insert({ project_id: projectId, version, channel: "live", notes: `Autopilot: ${title}`, rollout_percent: 10, auto_step: 30, step_hours: 6, error_threshold: 5, min_reports: 20, created_by: createdBy }).select("id").single();
  if (error || !r) return error?.message ?? "release insert failed";
  const manifest = { issuer: "jackboy", project: p!.client_key, release_id: r.id, version, channel: "live", notes: `Autopilot: ${title}`, config: {}, artifact: null, published_at };
  const { signature } = await signPayload((await signingKeys(secret)).privateKey, manifest);
  await supabaseAdmin.from("releases").update({ status: "rolling", manifest: manifest as never, signature, published_at, last_step_at: published_at }).eq("id", r.id);
  await audit(null, "autopilot.release", { project: projectId, version, percent: 10 });
  return `release ${version} rolling to 10%`;
}

/** Hourly: ship Autopilot PRs whose checks passed, and write fixes from new error reports. */
export async function autopilotTick() {
  const s = await settings();
  const result = { shipped: 0, held: 0, healthFixes: 0 };
  if (!s.autopilot_enabled || s.paused_reason) return result;
  const { data: open } = await supabaseAdmin.from("update_proposals").select("id, title, files, project_id, owner_projects(autopilot, created_by, name)").eq("status", "pr_open").limit(20);
  for (const o of open ?? []) {
    const proj = o.owner_projects as unknown as { autopilot: boolean; created_by: string; name: string } | null;
    if (!proj?.autopilot) continue;
    try {
      const checks = await refreshChecks(o.id);
      const gate = canAutoShip({ master: true, project: true, checks, paths: ((o.files as { path: string }[]) ?? []).map((f) => f.path) });
      if (!gate.ok) {
        await supabaseAdmin.from("update_proposals").update({ autopilot_note: `Autopilot holding: ${gate.reason}` }).eq("id", o.id);
        result.held++; continue;
      }
      await mergeProposal(o.id, proj.created_by);
      const rel = await publishAutoRelease(o.project_id, proj.created_by, o.title);
      await supabaseAdmin.from("update_proposals").update({ autopilot_note: `Autopilot shipped: merged, ${rel}` }).eq("id", o.id);
      await audit(null, "autopilot.shipped", { id: o.id, title: o.title, name: proj.name, release: rel });
      await notify("shipped", `Autopilot shipped "${o.title}" to ${proj.name} (${rel}).`, o.id);
      result.shipped++;
    } catch (e) { await audit(null, "autopilot.ship", { id: o.id, error: (e as Error).message }, "error"); }
  }
  // Health → fixes (at most one per project per day).
  const since = new Date(Date.now() - 86400_000).toISOString();
  const { data: projects } = await supabaseAdmin.from("owner_projects").select("id, name").eq("autopilot", true);
  for (const p of projects ?? []) {
    const { data: errs } = await supabaseAdmin.from("health_reports").select("message").eq("project_id", p.id).in("kind", ["error", "crash"]).gte("created_at", since).limit(50);
    if (!errs || errs.length < 5) continue;
    const { count } = await supabaseAdmin.from("update_proposals").select("id", { count: "exact", head: true }).eq("project_id", p.id).eq("source", "health").gte("created_at", since);
    if (count) continue;
    const grouped = new Map<string, number>();
    for (const e of errs) grouped.set(e.message || "(no message)", (grouped.get(e.message || "(no message)") ?? 0) + 1);
    try { await writeFix(p.id, [...grouped].map(([m, n]) => `- ${n}× ${m}`).join("\n"), "health", null); result.healthFixes++; }
    catch (e) { await audit(null, "autopilot.health_fix", { project: p.id, error: (e as Error).message }, "error"); if (e instanceof GatewayError) break; }
  }
  return result;
}

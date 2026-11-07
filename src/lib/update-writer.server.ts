import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { BATCH_SIZE, isDue, MAX_FILES, monthStart, parseProposal, parseRepo, underCap, type ProposalDraft } from "./update-writer";
import { pageText, parseFeed, safeFetchUrl, sha256Hex, tagProjects } from "./feeds";
import * as gh from "./github.server";
import { CREDIT_PAUSE, isCreditError, standaloneTestTask, WORK_FOCUS } from "./work-policy";

export const MODEL = "openai/gpt-6-astra";
const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "what_to_change", "why", "build_prompt", "files"],
  properties: {
    title: { type: "string" }, what_to_change: { type: "string" }, why: { type: "string" }, build_prompt: { type: "string" },
    files: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
  },
};

export class GatewayError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export const audit = (actor: string | null, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  supabaseAdmin.from("audit_logs").insert({ actor, action, detail: detail as never, outcome });

/** In-app notification. Email delivery is not set up (no sender domain), so it is recorded as such — never faked. */
export const notify = (kind: string, message: string, proposalId: string | null = null) =>
  proposalId
    // One notification per (kind, proposal): retries and races never create duplicates.
    ? supabaseAdmin.from("owner_notifications").upsert({ kind, message, proposal_id: proposalId, email_state: "not_configured" }, { onConflict: "kind,proposal_id", ignoreDuplicates: true })
    : supabaseAdmin.from("owner_notifications").insert({ kind, message, proposal_id: proposalId, email_state: "not_configured" });

async function usage(kind: "ai" | "run") {
  const { count } = await supabaseAdmin.from("usage_ledger").select("id", { count: "exact", head: true }).eq("kind", kind).gte("at", monthStart());
  return count ?? 0;
}

export async function capCheck(kind: "ai" | "run", cap: number): Promise<string | null> {
  if (underCap(await usage(kind), cap)) return null;
  const reason = `Monthly ${kind === "ai" ? "AI call" : "job run"} cap (${cap}) reached`;
  await supabaseAdmin.from("update_writer_settings").update({ paused_reason: reason }).eq("id", 1);
  await notify("cap", `${reason}. Scheduled updates are paused until you raise the cap or next month starts.`);
  await audit(null, "updates.cap", { kind, cap }, "paused");
  return reason;
}

export async function callAI(input: string): Promise<ProposalDraft> {
  const { data: pauseState } = await supabaseAdmin.from("update_writer_settings").select("paused_reason").eq("id", 1).single();
  if (pauseState?.paused_reason === CREDIT_PAUSE) throw new GatewayError(402, CREDIT_PAUSE);
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new GatewayError(401, "AI is not configured on the server.");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": key, Authorization: `Bearer ${key}`, "X-Lovable-AIG-SDK": "fetch" },
    body: JSON.stringify({
      model: MODEL, stream: true, store: false, reasoning: { effort: "medium" },
      instructions: [
        WORK_FOCUS,
        "You are Jackboy, an update writer for a software owner. Propose ONE small, concrete, high-value update that moves the project toward its goals, using the goals, notes and recent news items given.",
        "If a file list is given, also write the actual code change in `files`: each entry is a repo-relative path and the COMPLETE new file content (not a diff).",
        `At most ${MAX_FILES} files. Only edit or create files that fit the existing structure. Never touch .env files, .git, CI workflows, lockfiles, or secrets. Never include credentials.`,
        "If no file list is given, return files as an empty array. Never claim anything was tested or deployed.",
        "build_prompt must be a ready-to-paste build prompt for an AI app builder (OMNI/Lovable) describing the same change with acceptance checks.",
      ].join(" "),
      input,
      text: { format: { type: "json_schema", name: "update_proposal", strict: true, schema: SCHEMA } },
    }),
  });
  if (!res.ok || !res.body) {
    let msg = `AI request failed (${res.status})`;
    try { const j = (await res.json()) as { message?: string; error?: { message?: string } }; msg = j.message ?? j.error?.message ?? msg; } catch { /* ignore */ }
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
      let ev: { type?: string; delta?: string; error?: { message?: string } };
      try { ev = JSON.parse(d); } catch { continue; }
      if (ev.type === "response.output_text.delta" && ev.delta) text += ev.delta;
      if (ev.type === "response.failed" || ev.type === "error") throw new GatewayError(500, ev.error?.message ?? "AI response failed");
    }
  }
  if (!text.trim()) throw new GatewayError(422, "AI returned no proposal (possibly refused).");
  const draft = parseProposal(text);
  if (standaloneTestTask(draft.title, draft.files.map((f) => f.path))) throw new Error("Standalone test-only proposal skipped: identify the real feature this work unblocks before creating a task.");
  return draft;
}

export type Project = { id: string; name: string; lovable_url: string | null; description: string; goals: string; notes: string; github_repo: string | null; github_branch: string };

const CONTEXT_FILES = ["package.json", "README.md", "AGENTS.md", "src/routes/__root.tsx", "src/routes/index.tsx"];

export async function repoContext(p: Project) {
  const parsed = p.github_repo ? parseRepo(p.github_repo) : null;
  if (!parsed || !gh.githubConfigured()) return null;
  await gh.requirePrivateRepo(parsed.owner, parsed.repo);
  const paths = (await gh.getTreePaths(parsed.owner, parsed.repo, p.github_branch)).filter((x) => !x.startsWith("node_modules/") && !x.includes("/.") ).slice(0, 600);
  const files: string[] = [];
  for (const f of CONTEXT_FILES.filter((x) => paths.includes(x))) {
    const c = await gh.readFile(parsed.owner, parsed.repo, f, p.github_branch);
    if (c) files.push(`--- ${f} ---\n${c.slice(0, 8000)}`);
  }
  return { ...parsed, paths, files };
}

/** Opens a branch + PR for a proposal's files on the project's private repo. Never writes to the base branch. */
export async function deliver(proposalId: string, actor: string | null) {
  await (await import("./global-pause.server")).assertWorkAllowed();
  const { data: p } = await supabaseAdmin.from("update_proposals").select("*, owner_projects(*)").eq("id", proposalId).single();
  if (!p || !p.owner_projects) throw new Error("Proposal not found.");
  const proj = p.owner_projects as unknown as Project;
  const repo = proj.github_repo ? parseRepo(proj.github_repo) : null;
  const files = (p.files as { path: string; content: string }[]) ?? [];
  if (!repo) throw new Error("This project has no GitHub repo set.");
  if (!files.length) throw new Error("This proposal has no code changes.");
  try {
    await gh.requirePrivateRepo(repo.owner, repo.repo);
    const withPrev: { path: string; content: string; previous: string | null }[] = [];
    for (const f of files) withPrev.push({ ...f, previous: await gh.readFile(repo.owner, repo.repo, f.path, proj.github_branch) });
    const branch = p.branch_name ?? `jackboy/update-${proposalId.slice(0, 8)}-${Date.now().toString(36)}`;
    const sha = p.head_sha ?? await gh.commitToNewBranch(repo.owner, repo.repo, proj.github_branch, branch, `Jackboy: ${p.title}`, files);
    const checks = await gh.checksState(repo.owner, repo.repo, sha);
    if (checks !== "success") {
      await supabaseAdmin.from("update_proposals").update({ branch_name: branch, head_sha: sha, files: withPrev as never, checks_state: checks, delivery_error: "Draft PR blocked: existing tests must pass for this commit. Branch preserved; no PR opened." }).eq("id", proposalId);
      throw new Error("Draft PR blocked: existing tests must pass for this commit. No runner/checks, pending checks or failures cannot count as passed.");
    }
    const pr = await gh.openPullRequest(repo.owner, repo.repo, branch, proj.github_branch, `Jackboy: ${p.title}`,
      `**What:** ${p.what_to_change}\n\n**Why:** ${p.why}\n\n_Generated by Jackboy. Not merged until the owner approves in the Update Queue._`);
    await supabaseAdmin.from("update_proposals").update({ status: "pr_open", files: withPrev as never, branch_name: branch, pr_number: pr.number, pr_url: pr.html_url, head_sha: sha, checks_state: "pending", delivery_error: null }).eq("id", proposalId);
    await audit(actor, "updates.pr_open", { id: proposalId, title: p.title, repo: proj.github_repo, pr: pr.number });
    await notify("waiting", `Update ready for review: ${p.title} (${proj.name})`, proposalId);
  } catch (e) {
    const msg = (e as Error).message;
    await supabaseAdmin.from("update_proposals").update({ delivery_error: msg }).eq("id", proposalId);
    await audit(actor, "updates.pr_open", { id: proposalId, title: p.title, error: msg }, "error");
    throw e;
  }
}

export async function refreshChecks(proposalId: string) {
  const { data: p } = await supabaseAdmin.from("update_proposals").select("id, title, head_sha, checks_state, status, owner_projects(name, github_repo)").eq("id", proposalId).single();
  const proj = p?.owner_projects as { name: string; github_repo: string | null } | null;
  const repo = proj?.github_repo ? parseRepo(proj.github_repo) : null;
  if (!p || !repo || !p.head_sha || p.status !== "pr_open") return p?.checks_state ?? null;
  const state = await gh.checksState(repo.owner, repo.repo, p.head_sha);
  if (state !== p.checks_state) {
    await supabaseAdmin.from("update_proposals").update({ checks_state: state }).eq("id", proposalId);
    if (state === "failure") await notify("build_failed", `Build failed for update: ${p.title} (${proj!.name})`, proposalId);
  }
  return state;
}

export async function mergeProposal(proposalId: string, actor: string) {
  const { data: p } = await supabaseAdmin.from("update_proposals").select("*, owner_projects(github_repo)").eq("id", proposalId).single();
  const repo = p?.owner_projects?.github_repo ? parseRepo(p.owner_projects.github_repo) : null;
  if (!p || !repo || !p.pr_number || !p.head_sha) throw new Error("No open pull request.");
  await gh.requirePrivateRepo(repo.owner, repo.repo);
  const m = await gh.mergePullRequest(repo.owner, repo.repo, p.pr_number, p.head_sha);
  await supabaseAdmin.from("update_proposals").update({ status: "merged", merge_sha: m.sha, decided_by: actor, decided_at: new Date().toISOString() }).eq("id", proposalId);
  await audit(actor, "updates.merged", { id: proposalId, title: p.title, pr: p.pr_number, sha: m.sha });
}

export async function rejectProposal(proposalId: string, actor: string) {
  const { data: p } = await supabaseAdmin.from("update_proposals").select("*, owner_projects(github_repo)").eq("id", proposalId).single();
  if (!p) throw new Error("Not found.");
  const repo = p.owner_projects?.github_repo ? parseRepo(p.owner_projects.github_repo) : null;
  if (p.status === "pr_open" && repo && p.pr_number) await gh.closePullRequest(repo.owner, repo.repo, p.pr_number);
  await supabaseAdmin.from("update_proposals").update({ status: "rejected", decided_by: actor, decided_at: new Date().toISOString() }).eq("id", proposalId);
  await audit(actor, "updates.rejected", { id: proposalId, title: p.title, from: p.status });
}

/** Restores every touched file to its pre-update content via a new PR, then merges it (owner clicked revert). */
export async function revertProposal(proposalId: string, actor: string) {
  const { data: p } = await supabaseAdmin.from("update_proposals").select("*, owner_projects(github_repo, github_branch)").eq("id", proposalId).single();
  const proj = p?.owner_projects as { github_repo: string | null; github_branch: string } | null;
  const repo = proj?.github_repo ? parseRepo(proj.github_repo) : null;
  if (!p || !repo || p.status !== "merged") throw new Error("Only a merged update can be reverted.");
  await gh.requirePrivateRepo(repo.owner, repo.repo);
  const files = p.files as { path: string; previous: string | null }[];
  const branch = `jackboy/revert-${proposalId.slice(0, 8)}-${Date.now().toString(36)}`;
  const sha = await gh.commitToNewBranch(repo.owner, repo.repo, proj!.github_branch, branch, `Revert Jackboy: ${p.title}`, files.map((f) => ({ path: f.path, content: f.previous })));
  const pr = await gh.openPullRequest(repo.owner, repo.repo, branch, proj!.github_branch, `Revert Jackboy: ${p.title}`, `Reverts #${p.pr_number} at the owner's request.`);
  await gh.mergePullRequest(repo.owner, repo.repo, pr.number, sha);
  await supabaseAdmin.from("update_proposals").update({ status: "reverted", revert_pr_url: pr.html_url }).eq("id", proposalId);
  await audit(actor, "updates.reverted", { id: proposalId, title: p.title, pr: pr.number });
}

/** Polls active RSS/page sources (bounded). Webhook sources receive items via their endpoint instead. */
export async function pollFeeds(limit = 10) {
  const [{ data: sources }, { data: projects }] = await Promise.all([
    supabaseAdmin.from("feed_sources").select("*").eq("active", true).neq("kind", "webhook").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(limit),
    supabaseAdmin.from("owner_projects").select("id, name"),
  ]);
  let added = 0;
  for (const s of sources ?? []) {
    try {
      if (!s.url || !safeFetchUrl(s.url)) throw new Error("URL not allowed");
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(s.url, { signal: ctrl.signal, headers: { "User-Agent": "Jackboy feed reader" } }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.text()).slice(0, 2_000_000);
      const rows: { title: string; url: string | null; summary: string; published_at: string | null; dedupe: string }[] = [];
      if (s.kind === "rss") {
        for (const it of parseFeed(body)) rows.push({ ...it, dedupe: `${s.id}:${it.url ?? it.title}` });
      } else {
        const text = pageText(body); const h = await sha256Hex(text);
        if (s.last_hash && s.last_hash !== h) rows.push({ title: `Page changed: ${s.name}`, url: s.url, summary: text.slice(0, 1000), published_at: new Date().toISOString(), dedupe: `${s.id}:${h}` });
        await supabaseAdmin.from("feed_sources").update({ last_hash: h }).eq("id", s.id);
      }
      for (const r of rows) {
        const { error } = await supabaseAdmin.from("feed_items").insert({ source_id: s.id, dedupe_key: r.dedupe, title: r.title, url: r.url, summary: r.summary, published_at: r.published_at, project_ids: tagProjects(s.project_ids, `${r.title} ${r.summary}`, projects ?? []) });
        if (!error) added++;
      }
      await supabaseAdmin.from("feed_sources").update({ last_checked_at: new Date().toISOString(), last_error: null }).eq("id", s.id);
    } catch (e) {
      await supabaseAdmin.from("feed_sources").update({ last_checked_at: new Date().toISOString(), last_error: (e as Error).message.slice(0, 300) }).eq("id", s.id);
    }
  }
  return added;
}

/** Bounded, single-flight run. Caller must already be verified (owner or cron secret). */
export async function runUpdateWriter(opts: { trigger: "manual" | "scheduled"; actor: string | null; projectId?: string }) {
  const now = new Date();
  const { data: s } = await supabaseAdmin.from("update_writer_settings").select("*").eq("id", 1).single();
  if (!s) throw new Error("Settings missing.");
  const killed = await (await import("./global-pause.server")).readGlobalPause();
  if (killed) return { skipped: killed, created: 0, errors: [] as string[] };
  if (opts.trigger === "scheduled" && s.paused_reason) return { skipped: `paused: ${s.paused_reason}`, created: 0, errors: [] as string[] };
  const runCap = await capCheck("run", s.monthly_run_cap);
  if (runCap) return { skipped: runCap, created: 0, errors: [] as string[] };
  const { data: lock } = await supabaseAdmin.from("update_writer_settings")
    .update({ lock_until: new Date(now.getTime() + 600_000).toISOString() })
    .eq("id", 1).or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`).select("id");
  if (!lock?.length) return { skipped: "another run is in progress", created: 0, errors: [] as string[] };
  await supabaseAdmin.from("usage_ledger").insert({ kind: "run" });

  let created = 0; const errors: string[] = []; let pause: string | null = null;
  try {
    await pollFeeds();
    let q = supabaseAdmin.from("owner_projects").select("*").eq("active", true).order("last_run_at", { ascending: true, nullsFirst: true });
    if (opts.projectId) q = q.eq("id", opts.projectId);
    const { data: all } = await q.limit(50);
    const projects = (all ?? []).filter((p) => opts.trigger === "manual" || isDue(p.frequency_hours, p.last_run_at)).slice(0, BATCH_SIZE);
    for (const p of projects) {
      const aiCap = await capCheck("ai", s.monthly_ai_cap);
      if (aiCap) { errors.push(aiCap); break; }
      await supabaseAdmin.from("owner_projects").update({ last_run_at: new Date().toISOString() }).eq("id", p.id);
      try {
        const since = p.last_proposal_at ?? new Date(Date.now() - 14 * 86400_000).toISOString();
        const [{ data: recent }, { data: items }] = await Promise.all([
          supabaseAdmin.from("update_proposals").select("title").eq("project_id", p.id).order("created_at", { ascending: false }).limit(5),
          supabaseAdmin.from("feed_items").select("id, title, url, summary").contains("project_ids", [p.id]).gte("created_at", since).order("created_at", { ascending: false }).limit(10),
        ]);
        let ctx: Awaited<ReturnType<typeof repoContext>> = null; let repoNote = "";
        try { ctx = await repoContext(p); } catch (e) { repoNote = `Repo unavailable: ${(e as Error).message}`; }
        const input = [
          WORK_FOCUS,
          `Project: ${p.name}`, p.lovable_url ? `Link: ${p.lovable_url}` : "", `Description: ${p.description || "(none)"}`,
          `Goals:\n${p.goals || "(none)"}`, `Recent notes:\n${p.notes || "(none)"}`,
          items?.length ? `Recent news/feed items:\n${items.map((i) => `- ${i.title}${i.url ? ` (${i.url})` : ""}: ${i.summary.slice(0, 300)}`).join("\n")}` : "",
          recent?.length ? `Recent proposals already written (do not repeat):\n- ${recent.map((r) => r.title).join("\n- ")}` : "",
          ctx ? `Repository file list (${ctx.paths.length}):\n${ctx.paths.join("\n")}\n\nKey files:\n${ctx.files.join("\n\n")}` : "No repository access: return files as [].",
        ].filter(Boolean).join("\n\n");
        await supabaseAdmin.from("usage_ledger").insert({ kind: "ai", project_id: p.id });
        const d = await callAI(input);
        const files = ctx ? d.files : [];
        const { data: row, error } = await supabaseAdmin.from("update_proposals").insert({
          project_id: p.id, title: d.title, what_to_change: d.what_to_change, why: d.why, build_prompt: d.build_prompt,
          files: files as never, feed_item_ids: (items ?? []).map((i) => i.id), model: MODEL, trigger: opts.trigger, delivery_error: repoNote || null,
        }).select("id").single();
        if (error || !row) throw new Error(error?.message ?? "insert failed");
        await supabaseAdmin.from("owner_projects").update({ last_proposal_at: new Date().toISOString() }).eq("id", p.id);
        await audit(opts.actor, "updates.generate", { project: p.id, name: p.name, title: d.title, files: files.length, trigger: opts.trigger });
        created++;
        if (files.length) { try { await deliver(row.id, opts.actor); } catch (e) { errors.push(`${p.name}: PR not opened — ${(e as Error).message}`); } }
        else await notify("waiting", `Update proposal waiting: ${d.title} (${p.name})`, row.id);
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`${p.name}: ${msg}`);
        await audit(opts.actor, "updates.generate", { project: p.id, name: p.name, error: msg, trigger: opts.trigger }, "error");
        if (isCreditError(e)) { pause = CREDIT_PAUSE; await (await import("./credit-pause.server")).recordCreditPause(e); break; }
        if (e instanceof GatewayError && [401, 403].includes(e.status)) { pause = msg; break; }
        if (e instanceof GatewayError && e.status === 429) break;
      }
    }
    // Keep check status fresh for open PRs (bounded).
    const { data: open } = await supabaseAdmin.from("update_proposals").select("id").eq("status", "pr_open").limit(10);
    for (const o of open ?? []) { try { await refreshChecks(o.id); } catch { /* surfaced on next manual refresh */ } }
  } finally {
    await supabaseAdmin.from("update_writer_settings").update({ lock_until: null, last_run_at: new Date().toISOString(), ...(pause ? { paused_reason: pause } : {}) }).eq("id", 1);
    if (pause) await notify("paused", `Scheduled updates paused: ${pause}`);
  }
  return { skipped: null, created, errors };
}

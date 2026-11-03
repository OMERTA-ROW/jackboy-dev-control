// Server-only Jackboy → OMNI link: handshake, job dispatch with retries, result intake.
// Secrets: OMNI_API_URL, OMNI_API_KEY (Jackboy → OMNI bearer), OMNI_CALLBACK_SECRET (shared HMAC both ways).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logSite } from "./site-log.server";
import { DEFAULT_CALLBACK_URL, dispatchBackoffMs, hmacHex, JOB_CONTRACT, MAX_DISPATCH_ATTEMPTS, nextStatus, parseHandshake, safeEqual, type JobResult } from "./omni-link";

function config() {
  const url = process.env["OMNI_API_URL"], key = process.env["OMNI_API_KEY"], secret = process.env["OMNI_CALLBACK_SECRET"];
  const missing = [!url && "OMNI_API_URL", !key && "OMNI_API_KEY", !secret && "OMNI_CALLBACK_SECRET"].filter(Boolean) as string[];
  return { url: url?.replace(/\/$/, ""), key, secret, missing, callbackUrl: process.env["JACKBOY_CALLBACK_URL"] || DEFAULT_CALLBACK_URL };
}

export function omniConfigState() {
  const c = config();
  return { configured: c.missing.length === 0, keyConfigured: Boolean(c.key), missing: c.missing, callbackUrl: c.callbackUrl };
}

async function setConnection(patch: Record<string, unknown>) {
  await supabaseAdmin.from("omni_connection").update({ last_checked_at: new Date().toISOString(), ...patch }).eq("id", true);
}

/** Proves OMNI holds both keys: bearer accepted AND it returns HMAC(secret, challenge). Only success sets verified. */
export async function omniHandshake(actor: string) {
  const c = config();
  if (c.missing.length) {
    await setConnection({ verified: false, last_error: `Missing secrets: ${c.missing.join(", ")}` });
    return { verified: false, error: `Missing secrets: ${c.missing.join(", ")}` };
  }
  const challenge = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  try {
    const r = await fetch(`${c.url}/jackboy/handshake`, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ challenge, callbackUrl: c.callbackUrl }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`OMNI answered HTTP ${r.status}: ${text.slice(0, 200)}`);
    const h = parseHandshake(JSON.parse(text));
    if (typeof h === "string") throw new Error(h);
    if (!safeEqual(h.proof, await hmacHex(c.secret!, challenge))) throw new Error("OMNI proof did not match OMNI_CALLBACK_SECRET");
    await setConnection({ verified: true, verified_at: new Date().toISOString(), omni_version: h.version, capabilities: h.capabilities, last_error: null });
    await logSite({ actor, action: "omni.handshake", category: "config", status: "ok", summary: `OMNI ${h.version} verified (${h.capabilities.join(", ")})` });
    return { verified: true, version: h.version, capabilities: h.capabilities };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await setConnection({ verified: false, last_error: msg });
    await logSite({ actor, action: "omni.handshake", category: "config", status: "failed", summary: `OMNI handshake failed: ${msg}` });
    return { verified: false, error: msg };
  }
}

/** Sends due queued jobs to OMNI. Never sends unless the handshake has verified OMNI. */
export async function dispatchOmniJobs(limit = 10) {
  const c = config();
  const { data: conn } = await supabaseAdmin.from("omni_connection").select("verified").eq("id", true).maybeSingle();
  if (!conn?.verified || c.missing.length) return { sent: 0, failed: 0, skipped: "OMNI not verified" };
  const { data: due } = await supabaseAdmin.from("omni_jobs").select("id, kind, instructions, repo, project_id, attempts, code_request_id")
    .eq("status", "queued").lte("next_attempt_at", new Date().toISOString()).order("created_at").limit(limit);
  const out = { sent: 0, failed: 0 };
  for (const j of due ?? []) {
    try {
      const r = await fetch(`${c.url}/jackboy/jobs`, {
        method: "POST", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}`, "Idempotency-Key": j.id },
        body: JSON.stringify({ contract: JOB_CONTRACT, jobId: j.id, kind: j.kind, repo: j.repo, instructions: j.instructions, callbackUrl: c.callbackUrl }),
      });
      const text = await r.text();
      if (r.status !== 202 && r.status !== 200) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      let ref: string | null = null;
      try { ref = String((JSON.parse(text) as { ref?: unknown }).ref ?? "") || null; } catch { /* body optional */ }
      await supabaseAdmin.from("omni_jobs").update({ status: "sent", sent_at: new Date().toISOString(), attempts: j.attempts + 1, last_error: null, omni_job_ref: ref }).eq("id", j.id).eq("status", "queued");
      await logSite({ actor: "jackboy", action: "omni.dispatch", category: "delivery", status: "ok", summary: `Job ${j.id.slice(0, 8)} accepted by OMNI`, repo: j.repo });
      out.sent++;
    } catch (e) {
      const attempts = j.attempts + 1, msg = (e as Error).message.slice(0, 300);
      await supabaseAdmin.from("omni_jobs").update({ attempts, last_error: msg, status: attempts >= MAX_DISPATCH_ATTEMPTS ? "failed" : "queued", next_attempt_at: new Date(Date.now() + dispatchBackoffMs(attempts)).toISOString() }).eq("id", j.id);
      out.failed++;
    }
  }
  return out;
}

/** Applies a verified, fresh, non-replayed OMNI result. */
export async function applyOmniResult(nonce: string, r: JobResult) {
  const { error: dup } = await supabaseAdmin.from("omni_callback_nonces").insert({ nonce });
  if (dup) return { status: 409, body: "replayed nonce" };
  const { data: job } = await supabaseAdmin.from("omni_jobs").select("id, status, repo").eq("id", r.jobId).maybeSingle();
  if (!job) return { status: 404, body: "unknown job" };
  const next = nextStatus(job.status, r.status);
  if (!next) return { status: 200, body: `ignored: job already ${job.status}` };
  const done = next === "completed" || next === "failed";
  await supabaseAdmin.from("omni_jobs").update({ status: next, result: r as never, pr_url: r.prUrl, ...(done ? { completed_at: new Date().toISOString() } : {}) }).eq("id", job.id).eq("status", job.status);
  await logSite({
    actor: "omni", action: `omni.job.${next}`, category: r.tests ? "test" : "delivery", status: next === "failed" ? "failed" : next === "completed" ? "ok" : "pending",
    summary: `OMNI job ${job.id.slice(0, 8)}: ${r.summary || next}`, repo: job.repo, pr_url: r.prUrl,
    tests: r.tests ? `${r.tests.passed ? "passed" : "failed"}\n${r.tests.output.slice(0, 1500)}` : null,
  });
  return { status: 200, body: "ok" };
}

/** Queues an approved CODE request for OMNI (idempotent per request). */
export async function queueCodeForOmni(requestId: string, repo: string, instruction: string, userId: string) {
  const { error } = await supabaseAdmin.from("omni_jobs").upsert({ code_request_id: requestId, repo, kind: "code", instructions: instruction.slice(0, 4000), created_by: userId, project_id: null }, { onConflict: "code_request_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

export async function isOmniVerified() {
  const { data } = await supabaseAdmin.from("omni_connection").select("verified").eq("id", true).maybeSingle();
  return Boolean(data?.verified);
}

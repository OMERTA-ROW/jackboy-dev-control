// Server-only Jackboy → OMNI link: handshake, job dispatch with retries, result intake.
// Secrets: OMNI_API_URL, OMNI_API_KEY (Jackboy → OMNI bearer), OMNI_CALLBACK_SECRET (shared HMAC both ways).
import { supabaseAdmin as typedAdmin } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
const supabaseAdmin = untyped(typedAdmin);
import { logSite } from "./site-log.server";
import {
  DEFAULT_CALLBACK_URL,
  hmacHex,
  isOmniVerificationFresh,
  nextStatus,
  omniEndpointFingerprint,
  parseHandshake,
  safeEqual,
  type JobResult,
} from "./omni-link";

function config() {
  const url = process.env["OMNI_API_URL"], key = process.env["OMNI_API_KEY"], secret = process.env["OMNI_CALLBACK_SECRET"];
  const missing = [!url && "OMNI_API_URL", !key && "OMNI_API_KEY", !secret && "OMNI_CALLBACK_SECRET"].filter(Boolean) as string[];
  return { url: url?.replace(/\/$/, ""), key, secret, missing, callbackUrl: process.env["JACKBOY_CALLBACK_URL"] || DEFAULT_CALLBACK_URL };
}

export function omniConfigState() {
  const c = config();
  return { configured: c.missing.length === 0, keyConfigured: Boolean(c.key), missing: c.missing, callbackUrl: c.callbackUrl };
}

async function configHash(c = config()) {
  if (c.missing.length) return null;
  return omniEndpointFingerprint(c.url!);
}

async function setConnection(patch: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from("omni_connection").update({ last_checked_at: new Date().toISOString(), ...patch }).eq("id", true);
  if (error) throw new Error("OMNI verification state could not be updated.");
}

/** Proves OMNI holds both keys: bearer accepted AND it returns HMAC(secret, challenge). Only success sets verified. */
export async function omniHandshake(actor: string) {
  const c = config();
  if (c.missing.length) {
    await setConnection({
      verified: false,
      verified_at: null,
      config_hash: null,
      last_error: `Missing secrets: ${c.missing.join(", ")}`,
    });
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
    await setConnection({
      verified: true,
      verified_at: new Date().toISOString(),
      config_hash: await configHash(c),
      omni_version: h.version,
      capabilities: h.capabilities,
      last_error: null,
    });
    await logSite({ actor, action: "omni.handshake", category: "config", status: "ok", summary: `OMNI ${h.version} verified (${h.capabilities.join(", ")})` });
    return { verified: true, version: h.version, capabilities: h.capabilities };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await setConnection({ verified: false, verified_at: null, config_hash: null, last_error: msg });
    await logSite({ actor, action: "omni.handshake", category: "config", status: "failed", summary: `OMNI handshake failed: ${msg}` });
    return { verified: false, error: msg };
  }
}

/** A transport handshake is not a job-scoped owner authorization. */
export async function dispatchOmniJobs() {
  return {
    sent: 0,
    failed: 0,
    skipped: "Legacy OMNI dispatch is disabled until job-scoped owner authorization is available.",
  };
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

export async function isOmniVerified() {
  const c = config(), expectedHash = await configHash(c);
  if (!expectedHash) {
    await setConnection({ verified: false, verified_at: null, config_hash: null });
    return false;
  }
  const { data, error } = await supabaseAdmin
    .from("omni_connection")
    .select("verified, verified_at, config_hash")
    .eq("id", true)
    .maybeSingle();
  if (error || isOmniVerificationFresh(data, expectedHash)) return !error;
  if (data?.verified) {
    await setConnection({
      verified: false,
      verified_at: null,
      config_hash: null,
      last_error: "OMNI verification is stale or no longer matches configuration.",
    });
  }
  return false;
}

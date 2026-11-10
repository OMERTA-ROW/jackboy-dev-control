// Server-only Jackboy → OMNI link: handshake, job dispatch with retries, result intake.
// Secrets: OMNI_API_URL, OMNI_API_KEY (Jackboy → OMNI bearer), OMNI_CALLBACK_SECRET (shared HMAC both ways).
import { supabaseAdmin as typedAdmin } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
const supabaseAdmin = untyped(typedAdmin);
import { logSite } from "./site-log.server";
import {
  DEFAULT_CALLBACK_URL,
  HANDSHAKE_CONTRACT,
  hmacHex,
  isOmniVerificationFresh,
  omniApiUrl,
  OMNI_URL_FORMATTED_NOTICE,
  OMNI_URL_INVALID_MESSAGE,
  nextStatus,
  omniConfigurationFingerprint,
  parseHandshake,
  safeOmniDiagnostic,
  safeOmniCallbackOrigin,
  safeEqual,
  type JobResult,
} from "./omni-link";
import { LINK_AGED_MESSAGE, LINK_CONFIG_CHANGED_MESSAGE } from "./omni-handoff-auth";

function config() {
  const rawUrl = process.env["OMNI_API_URL"], key = process.env["OMNI_API_KEY"], secret = process.env["OMNI_CALLBACK_SECRET"];
  const missing = [!rawUrl && "OMNI_API_URL", !key && "OMNI_API_KEY", !secret && "OMNI_CALLBACK_SECRET"].filter(Boolean) as string[];
  const parsed = omniApiUrl(rawUrl);
  return {
    url: parsed.url ?? undefined,
    urlInvalid: Boolean(rawUrl) && !parsed.url,
    urlReformatted: parsed.reformatted,
    key, secret, missing,
    callbackUrl: process.env["JACKBOY_CALLBACK_URL"] || DEFAULT_CALLBACK_URL,
  };
}

export function omniConfigState() {
  const c = config();
  return {
    configured: c.missing.length === 0 && !c.urlInvalid,
    keyConfigured: Boolean(c.key),
    missing: c.missing,
    urlProblem: c.urlInvalid ? OMNI_URL_INVALID_MESSAGE : c.urlReformatted ? OMNI_URL_FORMATTED_NOTICE : null,
    callbackUrl: safeOmniCallbackOrigin(c.callbackUrl),
  };
}

async function configHash(c = config()) {
  if (c.missing.length) return null;
  return omniConfigurationFingerprint(c.url!, c.key!, c.secret!, c.callbackUrl);
}

async function setConnection(patch: Record<string, unknown>, actor?: string) {
  const { error } = await supabaseAdmin.from("omni_connection").update({ last_checked_at: new Date().toISOString(), ...patch }).eq("id", true);
  if (error) throw new Error("OMNI verification state could not be updated.");
  if (patch["verified"] === false && actor && process.env["JACKBOY_DISPATCH_V3_ENABLED"] === "true") {
    const { cancelRevokedOmniV3Receipts } = await import("./omni-dispatch-v3.server");
    await cancelRevokedOmniV3Receipts(actor);
  }
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
    }, actor);
    return { verified: false, error: `Missing secrets: ${c.missing.join(", ")}` };
  }
  if (c.urlInvalid || !c.url) {
    await setConnection({ verified: false, verified_at: null, config_hash: null, last_error: OMNI_URL_INVALID_MESSAGE }, actor);
    await logSite({ actor, action: "omni.handshake", category: "config", status: "failed", summary: `OMNI handshake failed: ${OMNI_URL_INVALID_MESSAGE}` });
    return { verified: false, error: OMNI_URL_INVALID_MESSAGE };
  }
  const challenge = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  // What OMNI actually answered, shown by "Test OMNI link" (contract/version/capabilities only, never the proof).
  const info: { httpStatus: number | null; contract: string | null; version: string | null; capabilities: string[] } = { httpStatus: null, contract: null, version: null, capabilities: [] };
  try {
    let r: Response;
    try {
      r = await fetch(`${c.url}/jackboy/handshake`, {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
        body: JSON.stringify({ challenge, callbackUrl: c.callbackUrl }),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new Error(`OMNI could not be reached (${timeout ? "timeout" : "network error"}).`);
    }
    info.httpStatus = r.status;
    if (!r.ok) throw new Error(`OMNI answered HTTP ${r.status}`);
    const text = await r.text();
    let response: unknown;
    try {
      response = JSON.parse(text);
    } catch {
      throw new Error("OMNI returned invalid handshake JSON");
    }
    const h = parseHandshake(response);
    if (typeof h === "string") throw new Error(h);
    info.contract = HANDSHAKE_CONTRACT;
    info.version = h.version;
    info.capabilities = h.capabilities;
    if (!safeEqual(h.proof, await hmacHex(c.secret!, challenge))) throw new Error("OMNI proof did not match OMNI_CALLBACK_SECRET");
    await setConnection({
      verified: true,
      verified_at: new Date().toISOString(),
      config_hash: await configHash(c),
      last_error: null,
    });
    await logSite({ actor, action: "omni.handshake", category: "config", status: "ok", summary: `OMNI handshake verified (version ${h.version}).` });
    return { verified: true, ...info };
  } catch (e) {
    const msg = safeOmniDiagnostic(e instanceof Error ? e.message : null) ?? "OMNI handshake failed; response details withheld.";
    await setConnection({ verified: false, verified_at: null, config_hash: null, last_error: msg }, actor);
    await logSite({ actor, action: "omni.handshake", category: "config", status: "failed", summary: `OMNI handshake failed: ${msg}` });
    return { verified: false, error: msg, ...info };
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

export async function isOmniVerified(actor?: string) {
  const c = config(), expectedHash = await configHash(c);
  if (!expectedHash) {
    // Missing settings count as a lost link: the DB trigger revokes live OMNI job approvals.
    const missing = `Missing secrets: ${c.missing.join(", ")}`;
    await setConnection({ verified: false, verified_at: null, config_hash: null, last_error: missing }, actor);
    return false;
  }
  const { data, error } = await supabaseAdmin
    .from("omni_connection")
    .select("verified, verified_at, config_hash")
    .eq("id", true)
    .maybeSingle();
  if (error || isOmniVerificationFresh(data, expectedHash)) return !error;
  if (data?.verified) {
    // Only a merely aged check keeps live approvals (still unusable until re-checked);
    // a settings change is a lost link and revokes them (see omni_link_lost_revoke).
    const changed = data.config_hash !== expectedHash;
    await setConnection({
      verified: false,
      verified_at: null,
      config_hash: null,
      last_error: changed ? LINK_CONFIG_CHANGED_MESSAGE : LINK_AGED_MESSAGE,
    }, actor);
  } else if (actor && process.env["JACKBOY_DISPATCH_V3_ENABLED"] === "true") {
    const { cancelRevokedOmniV3Receipts } = await import("./omni-dispatch-v3.server");
    await cancelRevokedOmniV3Receipts(actor);
  }
  return false;
}

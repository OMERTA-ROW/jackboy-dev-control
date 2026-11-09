// Server-only: owner-typed OMNI jobs from chat. Real HTTP to OMNI's inbox, never a simulated answer.
// Reads OMNI_API_URL / OMNI_API_KEY (bearer) / OMNI_ALLOWED_REPOS inside each call; the key never leaves the server.
import { assertWorkAllowed } from "./global-pause.server";
import { logSite } from "./site-log.server";
import { omniApiUrl, OMNI_URL_INVALID_MESSAGE } from "./omni-link";
import {
  isOmniJobFinished,
  isOmniJobId,
  OMNI_WORKER_NOTE,
  omniErrorText,
  omniFailure,
  omniJobBody,
  parseAllowedRepos,
  parseOmniAccepted,
  parseOmniStatus,
  pickOmniRepo,
  validateOmniJob,
  type OmniJobKind,
  type OmniJobStatus,
} from "./omni-jobs";

type Fetch = typeof fetch;
type Call = { ok: true; status: number; json: unknown } | { ok: false; status: number | null; error: string };

function config(): { url: string; key: string } | { error: string } {
  const key = process.env["OMNI_API_KEY"];
  const raw = process.env["OMNI_API_URL"];
  if (!raw || !key) return { error: `Missing secrets: ${[!raw && "OMNI_API_URL", !key && "OMNI_API_KEY"].filter(Boolean).join(", ")}` };
  const url = omniApiUrl(raw).url;
  return url ? { url, key } : { error: OMNI_URL_INVALID_MESSAGE };
}

async function omniCall(method: "GET" | "POST", path: string, body: unknown, extra: Record<string, string>, f: Fetch): Promise<Call> {
  const c = config();
  if ("error" in c) return { ok: false, status: null, error: c.error };
  const headers = new Headers({ Accept: "application/json", "User-Agent": "Jackboy", ...extra });
  headers.set("Authorization", ["Bearer", c.key].join(" "));
  if (body !== undefined) headers.set("Content-Type", "application/json");
  let r: Response;
  try {
    r = await f(`${c.url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, status: null, error: timeout ? "timed out after 15 seconds" : "network error" };
  }
  const text = await r.text().catch(() => "");
  if (!r.ok) return { ok: false, status: r.status, error: omniErrorText(text) };
  try {
    return { ok: true, status: r.status, json: JSON.parse(text) };
  } catch {
    return { ok: false, status: r.status, error: "OMNI's reply was not valid JSON" };
  }
}

export type OmniJobReply =
  | { sent: true; jobId: string; httpStatus: number; duplicate: boolean; status: string; result: OmniJobStatus["result"]; repo: string; kind: OmniJobKind; note: string; evidence: { label: string; url: string }[] }
  | { sent: false; ran: false; jobId: string | null; httpStatus: number | null; error: string };

/** Checks status a few times so quick jobs return OMNI's real output in the same reply. */
export async function getOmniJob(jobId: string, f: Fetch = fetch): Promise<{ ok: true; httpStatus: number; job: OmniJobStatus } | { ok: false; httpStatus: number | null; error: string }> {
  if (!isOmniJobId(jobId)) return { ok: false, httpStatus: null, error: "That is not an OMNI job ID." };
  const r = await omniCall("GET", `/jackboy/jobs/${jobId}`, undefined, {}, f);
  if (!r.ok) return { ok: false, httpStatus: r.status, error: r.status === null ? `OMNI could not be reached (${r.error}).` : `OMNI answered HTTP ${r.status}: ${r.error}.` };
  const job = parseOmniStatus(r.json);
  if (!job || job.id !== jobId) return { ok: false, httpStatus: r.status, error: "OMNI's status reply did not match this job." };
  return { ok: true, httpStatus: r.status, job };
}

export async function submitOmniJob(
  actor: string,
  input: { kind: OmniJobKind; repo?: string | undefined; instructions: string; patch?: string | undefined },
  opts: { fetch?: Fetch; waitMs?: number; pollMs?: number } = {},
): Promise<OmniJobReply> {
  const f = opts.fetch ?? fetch;
  const refuse = async (error: string, httpStatus: number | null = null, jobId: string | null = null): Promise<OmniJobReply> => {
    await logSite({ actor, action: "omni.chat_job.refused", category: "delivery", status: "failed", summary: `OMNI job not run: ${error}`, detail: { jobId, httpStatus } });
    return { sent: false, ran: false, jobId, httpStatus, error };
  };
  try {
    await assertWorkAllowed();
  } catch (e) {
    return refuse(`${e instanceof Error ? e.message : "The Kill Switch is on."} The job did not run.`);
  }
  const picked = pickOmniRepo(input.repo, parseAllowedRepos(process.env["OMNI_ALLOWED_REPOS"]));
  if ("error" in picked) return refuse(`${picked.error} The job did not run.`);
  const job = { kind: input.kind, repo: picked.repo, instructions: input.instructions, patch: input.patch };
  const bad = validateOmniJob(job);
  if (bad) return refuse(`${bad} The job did not run.`);
  const jobId = crypto.randomUUID();
  const r = await omniCall("POST", "/jackboy/jobs", omniJobBody(jobId, job), { "Idempotency-Key": jobId }, f);
  if (!r.ok) return refuse(omniFailure(r.status, r.error), r.status, jobId);
  const accepted = parseOmniAccepted(r.json);
  if (!accepted || accepted.ref !== jobId) return refuse(`OMNI answered HTTP ${r.status} without confirming this job. Treat it as not run.`, r.status, jobId);
  await logSite({ actor, action: "omni.chat_job.submitted", category: "delivery", status: "pending", repo: job.repo, summary: `OMNI accepted ${job.kind} job ${jobId.slice(0, 8)} (HTTP ${r.status}).`, detail: { jobId, httpStatus: r.status, duplicate: accepted.duplicate } });
  let status = accepted.status;
  let result: OmniJobStatus["result"] = null;
  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  while (!isOmniJobFinished(status) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, opts.pollMs ?? 3_000));
    const s = await getOmniJob(jobId, f);
    if (!s.ok) break;
    status = s.job.status;
    result = s.job.result;
  }
  if (isOmniJobFinished(status)) {
    await logSite({ actor, action: `omni.chat_job.${status}`, category: "test", status: status === "completed" ? "ok" : "failed", repo: job.repo, summary: `OMNI job ${jobId.slice(0, 8)}: ${result?.summary || status}`, tests: result?.tests ? `${result.tests.passed ? "passed" : "failed"}\n${result.tests.output.slice(0, 1500)}` : null });
  }
  return { sent: true, jobId, httpStatus: r.status, duplicate: accepted.duplicate, status, result, repo: job.repo, kind: job.kind, note: OMNI_WORKER_NOTE, evidence: [{ label: "Activity log", url: "/site-log" }] };
}

// Chat may read OMNI status, but cannot bypass the existing project/job approval flow.
// Reads OMNI_API_URL / OMNI_API_KEY (bearer) / OMNI_ALLOWED_REPOS inside each call; the key never leaves the server.
import { assertWorkAllowed } from "./global-pause.server";
import { logSite } from "./site-log.server";
import { omniApiUrl, OMNI_URL_INVALID_MESSAGE } from "./omni-link";
import {
  isOmniJobId,
  OMNI_CHAT_EXECUTION_BLOCKED,
  omniErrorText,
  parseAllowedRepos,
  parseOmniStatus,
  pickOmniRepo,
  validateOmniJob,
  type OmniJobKind,
  type OmniJobStatus,
} from "./omni-jobs";

type Fetch = typeof fetch;
type Call =
  { ok: true; status: number; json: unknown } | { ok: false; status: number | null; error: string };

function config(): { url: string; key: string } | { error: string } {
  const key = process.env["OMNI_API_KEY"];
  const raw = process.env["OMNI_API_URL"];
  if (!raw || !key)
    return {
      error: `Missing secrets: ${[!raw && "OMNI_API_URL", !key && "OMNI_API_KEY"].filter(Boolean).join(", ")}`,
    };
  const url = omniApiUrl(raw).url;
  return url ? { url, key } : { error: OMNI_URL_INVALID_MESSAGE };
}

async function omniStatus(jobId: string, f: Fetch): Promise<Call> {
  const c = config();
  if ("error" in c) return { ok: false, status: null, error: c.error };
  const headers = new Headers({ Accept: "application/json", "User-Agent": "Jackboy" });
  headers.set("Authorization", ["Bearer", c.key].join(" "));
  let r: Response;
  try {
    r = await f(`${c.url}/jackboy/jobs/${jobId}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      status: null,
      error: timeout ? "timed out after 15 seconds" : "network error",
    };
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
  | {
      sent: true;
      jobId: string;
      httpStatus: number;
      duplicate: boolean;
      status: string;
      result: OmniJobStatus["result"];
      repo: string;
      kind: OmniJobKind;
      note: string;
      evidence: { label: string; url: string }[];
    }
  | { sent: false; ran: false; jobId: string | null; httpStatus: number | null; error: string };

/** Reads status only; a transport response never creates execution authority. */
export async function getOmniJob(
  jobId: string,
  f: Fetch = fetch,
): Promise<
  | { ok: true; httpStatus: number; job: OmniJobStatus }
  | { ok: false; httpStatus: number | null; error: string }
> {
  if (!isOmniJobId(jobId))
    return { ok: false, httpStatus: null, error: "That is not an OMNI job ID." };
  const r = await omniStatus(jobId, f);
  if (!r.ok)
    return {
      ok: false,
      httpStatus: r.status,
      error:
        r.status === null
          ? `OMNI could not be reached (${r.error}).`
          : `OMNI answered HTTP ${r.status}: ${r.error}.`,
    };
  const job = parseOmniStatus(r.json);
  if (!job || job.id !== jobId)
    return {
      ok: false,
      httpStatus: r.status,
      error: "OMNI's status reply did not match this job.",
    };
  return { ok: true, httpStatus: r.status, job };
}

export async function submitOmniJob(
  actor: string,
  input: {
    kind: OmniJobKind;
    repo?: string | undefined;
    instructions: string;
    patch?: string | undefined;
  },
  _opts: { fetch?: Fetch; waitMs?: number; pollMs?: number } = {},
): Promise<OmniJobReply> {
  const refuse = async (
    error: string,
    httpStatus: number | null = null,
    jobId: string | null = null,
  ): Promise<OmniJobReply> => {
    await logSite({
      actor,
      action: "omni.chat_job.refused",
      category: "delivery",
      status: "failed",
      summary: `OMNI job not run: ${error}`,
      detail: { jobId, httpStatus },
    });
    return { sent: false, ran: false, jobId, httpStatus, error };
  };
  try {
    await assertWorkAllowed();
  } catch (e) {
    return refuse(
      `${e instanceof Error ? e.message : "The Kill Switch is on."} The job did not run.`,
    );
  }
  const picked = pickOmniRepo(input.repo, parseAllowedRepos(process.env["OMNI_ALLOWED_REPOS"]));
  if ("error" in picked) return refuse(`${picked.error} The job did not run.`);
  const job = {
    kind: input.kind,
    repo: picked.repo,
    instructions: input.instructions,
    patch: input.patch,
  };
  const bad = validateOmniJob(job);
  if (bad) return refuse(`${bad} The job did not run.`);
  return refuse(`${OMNI_CHAT_EXECUTION_BLOCKED} The job did not run.`);
}

// Pure rules for owner-typed OMNI jobs sent from chat (OMNI inbox: POST /jackboy/jobs, GET /jackboy/jobs/{id}).
// Runtime-neutral and tested. Nothing here talks to the network.
import { redact } from "./site-log";
import { JOB_CONTRACT } from "./omni-link";

export type OmniJobKind = "code" | "test";
export type OmniJobInput = { kind: OmniJobKind; repo: string; instructions: string; patch?: string | undefined };

export const OMNI_JOB_MAX_INSTRUCTIONS = 4000;
export const OMNI_JOB_MAX_PATCH = 200 * 1024;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What OMNI's current worker really does, so chat never implies it ran an arbitrary command. */
export const OMNI_WORKER_NOTE =
  "OMNI's worker does not run shell commands. It clones the allowed repository into a throwaway folder, applies a patch if one was sent, runs go test ./... and never pushes. Your text was sent as the job's instructions.";

/** Comma-separated owner/repo list (same format OMNI uses). Invalid entries are dropped. */
export function parseAllowedRepos(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((r) => r.trim()).filter((r) => REPO.test(r)))];
}

/** Picks the job's repository: the requested one must be on Jackboy's list; no request uses the first entry. */
export function pickOmniRepo(requested: string | undefined, allowed: string[]): { repo: string } | { error: string } {
  const want = requested?.trim();
  if (want) {
    if (!REPO.test(want)) return { error: `"${want.slice(0, 100)}" is not an owner/repo name.` };
    if (allowed.length && !allowed.includes(want)) return { error: `${want} is not on Jackboy's OMNI repository list (OMNI_ALLOWED_REPOS).` };
    return { repo: want };
  }
  if (!allowed.length) return { error: "No repository was named and OMNI_ALLOWED_REPOS is empty, so Jackboy can't pick one." };
  return { repo: allowed[0]! };
}

export function validateOmniJob(input: OmniJobInput): string | null {
  if (input.kind !== "code" && input.kind !== "test") return "Job kind must be code or test.";
  if (!REPO.test(input.repo)) return "Repository must be an owner/repo name.";
  if (!input.instructions.trim()) return "The job needs instructions.";
  if (input.instructions.length > OMNI_JOB_MAX_INSTRUCTIONS) return `Instructions are longer than ${OMNI_JOB_MAX_INSTRUCTIONS} characters.`;
  if (input.patch && input.patch.length > OMNI_JOB_MAX_PATCH) return "The patch is larger than 200 KB.";
  return null;
}

/** Exact omni.job/v1 body. OMNI requires Idempotency-Key === jobId. */
export function omniJobBody(jobId: string, input: OmniJobInput) {
  return {
    contract: JOB_CONTRACT,
    jobId,
    kind: input.kind,
    repo: input.repo,
    instructions: input.instructions.trim(),
    ...(input.patch?.trim() ? { patch: input.patch } : {}),
  };
}

/** OMNI's plain-text error, made safe for chat: one line, short, credentials redacted. */
export function omniErrorText(body: string): string {
  const line = redact(body.replace(/\s+/g, " ").trim()).slice(0, 200);
  return line || "no details";
}

/** The real failure, always with the HTTP status when there was one, and always saying the job did not run. */
export function omniFailure(status: number | null, detail: string): string {
  return status === null
    ? `OMNI could not be reached (${detail}). The job did not run.`
    : `OMNI answered HTTP ${status}: ${detail}. The job did not run.`;
}

export type OmniJobResult = {
  status: string;
  summary: string;
  tests: { passed: boolean; output: string } | null;
  diffStat: string | null;
};
export type OmniJobStatus = { id: string; status: string; result: OmniJobResult | null };

export function parseOmniAccepted(x: unknown): { accepted: boolean; ref: string; duplicate: boolean; status: string } | null {
  const o = x as Record<string, unknown> | null;
  if (!o || o["accepted"] !== true || typeof o["ref"] !== "string" || !UUID.test(o["ref"])) return null;
  return { accepted: true, ref: o["ref"], duplicate: o["duplicate"] === true, status: typeof o["status"] === "string" ? o["status"].slice(0, 40) : "unknown" };
}

export function parseOmniStatus(x: unknown): OmniJobStatus | null {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o["id"] !== "string" || !UUID.test(o["id"]) || typeof o["status"] !== "string") return null;
  const r = o["result"] as Record<string, unknown> | null | undefined;
  const t = r?.["tests"] as Record<string, unknown> | null | undefined;
  return {
    id: o["id"],
    status: o["status"].slice(0, 40),
    result: r
      ? {
          status: String(r["status"] ?? "").slice(0, 40),
          summary: redact(String(r["summary"] ?? "")).slice(0, 2000),
          tests: t && typeof t["passed"] === "boolean" ? { passed: t["passed"], output: redact(String(t["output"] ?? "")).slice(0, 8000) } : null,
          diffStat: typeof r["diffStat"] === "string" && r["diffStat"] ? redact(r["diffStat"]).slice(0, 4000) : null,
        }
      : null,
  };
}

export const isOmniJobFinished = (status: string) => status === "completed" || status === "failed";
export const isOmniJobId = (id: string) => UUID.test(id);

/** Random lowercase hex challenge within OMNI's 32–200 character rule. */
export function omniChallenge(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

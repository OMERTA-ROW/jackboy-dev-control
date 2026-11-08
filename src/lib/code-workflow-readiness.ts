import { parseCodeTargets } from "./code-safety";

const repo = "OMERTA-ROW/jackboy-dev-control";

/**
 * GitHub's own on/off state for the CODE workflow. Matching pins mean nothing if GitHub refuses to start
 * the workflow: `verify()` already blocks dispatch unless the state is exactly "active", so readiness must say so.
 */
export function workflowStateProblem(state: string | null | undefined): string | null {
  if (state === "active") return null;
  if (state === "disabled_manually")
    return "The CODE workflow is turned off in GitHub (disabled manually), so no CODE run can start. Owner fix: GitHub → jackboy-dev-control → Actions → CODE → “Enable workflow”, then press Test.";
  if (typeof state === "string" && state.length > 0)
    return `GitHub reports the CODE workflow as "${state}", so no CODE run can start. Owner fix: GitHub → jackboy-dev-control → Actions → CODE → “Enable workflow”, then press Test.`;
  return "GitHub didn't report the CODE workflow's on/off state, so it is treated as off.";
}

/** Evidence only: never changes the stored or configured authorization. */
export function workflowPinReport(stored: unknown, configured: string | undefined, liveSha: string | null) {
  let databaseSha: string | null = null;
  let configuredSha: string | null = null;
  let valid = false;
  try {
    const database = parseCodeTargets(stored);
    const policy = parseCodeTargets(JSON.parse(configured ?? "null"));
    valid = [database, policy].every((targets) => Object.keys(targets).length === 1 && targets[repo]?.ref === "main");
    databaseSha = database[repo]?.workflowSha ?? null;
    configuredSha = policy[repo]?.workflowSha ?? null;
  } catch { /* Missing/invalid policy is blocked, never inferred. */ }
  const liveVerified = typeof liveSha === "string" && /^[a-f0-9]{40}$/.test(liveSha);
  return {
    databaseSha,
    configuredSha,
    liveSha: liveVerified ? liveSha : null,
    matches: valid && liveVerified && databaseSha === liveSha && configuredSha === liveSha,
    proposedTargets: liveVerified ? { [repo]: { ref: "main", workflowSha: liveSha } } : null,
  };
}
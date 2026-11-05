import { parseCodeTargets } from "./code-safety";

const repo = "OMERTA-ROW/jackboy-dev-control";

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
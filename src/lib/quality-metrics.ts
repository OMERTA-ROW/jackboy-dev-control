// Code Foundry quality metrics, computed only from stored records.
// A rate with no qualifying records is null ("not enough data"), never 0% or 100%.
export type Rate = { value: number | null; num: number; den: number; note: string };
const rate = (num: number, den: number, note: string): Rate => ({ value: den > 0 ? Math.round((num / den) * 1000) / 10 : null, num, den, note });

export type MetricInput = {
  tasks: { state: string; test_evidence: unknown }[];
  proposals: { status: string; checks_state: string | null; revert_pr_url: string | null }[];
  releases: { status: string }[];
  installs: { phase: string }[];
};

export function qualityMetrics(i: MetricInput) {
  const ended = i.tasks.filter((t) => ["completed", "failed", "rolled_back"].includes(t.state));
  const ev = i.tasks.map((t) => ((t.test_evidence ?? {}) as { status?: string }).status ?? "none");
  const ran = ev.filter((s) => s === "passed" || s === "failed");
  const notRunnable = ev.filter((s) => s === "not_runnable").length;
  const checks = i.proposals.filter((p) => p.checks_state === "success" || p.checks_state === "failure");
  const merged = i.proposals.filter((p) => p.status === "merged" || p.status === "reverted");
  const shipped = i.releases.filter((r) => ["rolling", "live", "completed", "rolled_back", "paused"].includes(r.status));
  const attempts = i.installs.filter((x) => ["installed", "failed", "healthy", "rolled_back"].includes(x.phase));
  return {
    repairSuccess: rate(ended.filter((t) => t.state === "completed").length, ended.length, "Finished repair tasks that completed (vs failed or rolled back)"),
    testFailure: rate(ran.filter((s) => s === "failed").length + checks.filter((p) => p.checks_state === "failure").length, ran.length + checks.length, notRunnable ? `${notRunnable} task(s) had no runnable tests` : "Real test/CI results only"),
    regression: rate(merged.filter((p) => p.status === "reverted" || p.revert_pr_url).length, merged.length, "Merged updates later reverted"),
    failedDeployment: rate(attempts.filter((x) => x.phase === "failed").length, attempts.length, "Update installs reported as failed"),
    rollback: rate(shipped.filter((r) => r.status === "rolled_back").length, shipped.length, "Released versions rolled back"),
    testsNotRunnable: notRunnable,
  };
}
export type QualityMetrics = ReturnType<typeof qualityMetrics>;

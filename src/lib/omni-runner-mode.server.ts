import { remoteRunnerConfig, runnerConfigProblem } from "./omni-remote-runner";
import { protocolRunnerAvailable } from "./omni-session-runner.server";
// Which self-test runner the live link would use. Names/state only, never secret values.
export function runnerMode(env: Record<string, string | undefined> = process.env): "local" | "remote" | "none" {
  if (protocolRunnerAvailable()) return "local";
  return remoteRunnerConfig(env) ? "remote" : "none";
}
/** Which remote-runner setting blocks it (setting names only), or null when a runner is available. */
export function runnerProblem(env: Record<string, string | undefined> = process.env): string | null {
  return runnerMode(env) === "none" ? runnerConfigProblem(env) : null;
}

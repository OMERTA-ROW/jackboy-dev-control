// Tester-facing capability status, derived only from live manifest checks plus the global safety switches.
import type { AgentManifest, Capability } from "./agent-manifest";

export type TesterStatus = "working" | "needs_testing" | "not_connected";
export type Safety = { emergencyPause: boolean; schedules: boolean; autopilot: boolean };
export type TesterCapability = { id: string; label: string; status: TesterStatus; detail: string; fix?: string; actionsActive: boolean };

// Built and operational on paper, but never verified end-to-end; never shown as "working".
const UNVERIFIED = new Set(["voice", "ci_results"]);

export function testerStatus(c: Capability): TesterStatus {
  if (c.status === "not_built" || c.status === "blocked") return "not_connected";
  return UNVERIFIED.has(c.id) ? "needs_testing" : "working";
}

/** Actions are only ever active for working, non-production capabilities while the emergency pause is off. */
export function toTester(m: AgentManifest, s: Safety): TesterCapability[] {
  return m.capabilities.map((c) => {
    const status = testerStatus(c);
    return { id: c.id, label: c.label, status, detail: c.detail, ...(c.fix ? { fix: c.fix } : {}), actionsActive: status === "working" && c.risk !== "production" && !s.emergencyPause };
  });
}

// Pure updater policy engine: decides whether an enrolled target may receive a signed release, and which install phase reports are valid.
import { compareVersions } from "./update-server";

export type Compatibility = { platforms?: string[]; min_from_version?: string } | null | undefined;
export type PolicyRelease = { status: string; channel: string; version: string; compatibility?: Compatibility };
export type PolicyTarget = { channel: string; platform: string; current_version: string | null; revoked: boolean };
export type PolicyResult = { allow: boolean; rollback: boolean; reasons: string[] };

/** Owner publishing is the approval; only rolling/complete releases ever pass. Downgrades are allowed only as rollback. */
export function policyCheck(rel: PolicyRelease, t: PolicyTarget): PolicyResult {
  const reasons: string[] = [];
  if (t.revoked) reasons.push("target revoked");
  if (rel.status !== "rolling" && rel.status !== "complete") reasons.push(`release not owner-published (${rel.status})`);
  if (rel.channel !== t.channel) reasons.push(`channel mismatch (${rel.channel} vs ${t.channel})`);
  const c = rel.compatibility ?? null;
  if (c?.platforms?.length && !c.platforms.includes(t.platform)) reasons.push(`platform ${t.platform} not supported`);
  if (c?.min_from_version && t.current_version && compareVersions(t.current_version, c.min_from_version) < 0) reasons.push(`requires current version ≥ ${c.min_from_version}`);
  const rollback = !!t.current_version && compareVersions(rel.version, t.current_version) < 0;
  return { allow: reasons.length === 0, rollback, reasons };
}

export const INSTALL_PHASES = ["policy_denied", "downloaded", "verified", "installed", "healthy", "failed", "rolled_back"] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

/** Target state after a reported phase. */
export function stateAfter(phase: InstallPhase): "updating" | "healthy" | "failed" | "rolled_back" | "up_to_date" {
  if (phase === "healthy") return "healthy";
  if (phase === "failed") return "failed";
  if (phase === "rolled_back") return "rolled_back";
  if (phase === "policy_denied") return "up_to_date";
  return "updating";
}

/** Reads optional compatibility from release config ({ compat: { platforms, min_from_version } }). */
export function compatFromConfig(config: unknown): Compatibility {
  const c = (config as { compat?: { platforms?: unknown; min_from_version?: unknown } } | null)?.compat;
  if (!c) return null;
  const platforms = Array.isArray(c.platforms) ? c.platforms.filter((p): p is string => typeof p === "string").slice(0, 20) : undefined;
  const min = typeof c.min_from_version === "string" ? c.min_from_version : undefined;
  return { ...(platforms ? { platforms } : {}), ...(min ? { min_from_version: min } : {}) };
}

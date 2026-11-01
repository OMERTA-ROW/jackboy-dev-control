// Pure endpoint patch-policy + monitoring rules (vendor-neutral). No device access here: inputs come only from enrolled, signed updater clients.

export type Severity = "none" | "low" | "medium" | "high" | "critical";
export type Ring = "canary" | "early" | "broad";
export type Workstream = "code_repair" | "endpoint_patch" | "infrastructure";

export type EndpointFacts = {
  os: "macos" | "windows" | "linux" | "web";
  arch: "arm64" | "x64" | "any";
  ring: Ring;
  enrolled: boolean;
  diskFreePct: number;
  cpuPct: number;
  memPct: number;
};

export type PatchCandidate = {
  workstream: Workstream;
  os: EndpointFacts["os"][];
  arch: EndpointFacts["arch"][];
  severity: Severity;
  signatureVerified: boolean;
  provenanceTrusted: boolean;
  requiresReboot: boolean;
  ownerApproved: boolean;
  allowedRings: Ring[];
};

export type Window = { startHourUtc: number; endHourUtc: number; allowReboot: boolean };

export type Decision = { allow: boolean; needsApproval: boolean; reasons: string[] };

export const HEALTH_LIMITS = { minDiskFreePct: 10, maxCpuPct: 90, maxMemPct: 90 } as const;

export function inWindow(hourUtc: number, w: Window): boolean {
  return w.startHourUtc <= w.endHourUtc ? hourUtc >= w.startHourUtc && hourUtc < w.endHourUtc : hourUtc >= w.startHourUtc || hourUtc < w.endHourUtc;
}

/** Every patch needs owner approval; nothing unsigned or from untrusted provenance ever installs. */
export function evaluatePatch(p: PatchCandidate, e: EndpointFacts, w: Window, hourUtc: number): Decision {
  const r: string[] = [];
  if (p.workstream !== "endpoint_patch") r.push(`wrong workstream (${p.workstream})`);
  if (!e.enrolled) r.push("endpoint not enrolled");
  if (!p.signatureVerified) r.push("signature not verified");
  if (!p.provenanceTrusted) r.push("untrusted source provenance");
  if (!p.os.includes(e.os)) r.push(`os ${e.os} not supported`);
  if (e.arch !== "any" && !p.arch.includes(e.arch) && !p.arch.includes("any")) r.push(`arch ${e.arch} not supported`);
  if (!p.allowedRings.includes(e.ring)) r.push(`ring ${e.ring} not yet released`);
  if (!inWindow(hourUtc, w)) r.push("outside maintenance window");
  if (p.requiresReboot && !w.allowReboot) r.push("reboot not allowed in window");
  if (e.diskFreePct < HEALTH_LIMITS.minDiskFreePct) r.push("low disk space");
  if (e.cpuPct > HEALTH_LIMITS.maxCpuPct) r.push("cpu busy");
  if (e.memPct > HEALTH_LIMITS.maxMemPct) r.push("memory pressure");
  const needsApproval = !p.ownerApproved;
  if (needsApproval) r.push(p.severity === "critical" ? "critical patch awaiting owner approval" : "awaiting owner approval");
  return { allow: r.length === 0, needsApproval, reasons: r };
}

/** Threshold + duration + hysteresis alerting; returns new state and whether to open/close a deduplicated job. */
export type AlertRule = { threshold: number; clearBelow: number; forSamples: number };
export type AlertState = { firing: boolean; breachCount: number };

export function stepAlert(s: AlertState, value: number, rule: AlertRule): { state: AlertState; open: boolean; close: boolean } {
  if (s.firing) {
    if (value < rule.clearBelow) return { state: { firing: false, breachCount: 0 }, open: false, close: true };
    return { state: s, open: false, close: false };
  }
  const breachCount = value >= rule.threshold ? s.breachCount + 1 : 0;
  if (breachCount >= rule.forSamples) return { state: { firing: true, breachCount }, open: true, close: false };
  return { state: { firing: false, breachCount }, open: false, close: false };
}

export function alertDedupeKey(endpointId: string, metric: string): string {
  return `endpoint:${endpointId}:${metric}`;
}

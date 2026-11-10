import { describe, expect, it } from "vitest";
import { describeV3Job, v3ExpiresAt, v3Payload, v3SafetyGate } from "./omni-dispatch-v3";

const now = Date.parse("2026-11-10T01:00:00Z");
const ok = {
  paused: false,
  controls: { kill_switch: false, usage_spike: false, consecutive_failures: 0, daily_spend_limit_usd: "5.00" },
  todaySpendUsd: 1,
  allowedRepos: ["acme/repo"],
  repo: "acme/repo",
};

describe("v3 dispatch rules", () => {
  it("expiry must be in the future and at most 30 minutes out", () => {
    expect(v3ExpiresAt("2026-11-10T01:15:00Z", now)).toBe(now / 1000 + 900);
    expect(v3ExpiresAt("2026-11-10T01:30:00Z", now)).toBe(now / 1000 + 1800);
    expect(() => v3ExpiresAt("2026-11-10T01:30:01Z", now)).toThrow("30 minutes");
    expect(() => v3ExpiresAt("2026-11-10T01:00:00Z", now)).toThrow("expired");
    expect(() => v3ExpiresAt("not a date", now)).toThrow();
  });
  it("payload limit is 6 KB in bytes", () => {
    expect(v3Payload("x".repeat(6144))).toHaveLength(6144);
    expect(() => v3Payload("x".repeat(6145))).toThrow("6 KB");
    expect(() => v3Payload("é".repeat(3073))).toThrow("6 KB");
  });
  it("safety gate fails closed", () => {
    expect(v3SafetyGate(ok)).toBeNull();
    expect(v3SafetyGate({ ...ok, paused: null })).toMatch("Kill Switch");
    expect(v3SafetyGate({ ...ok, controls: null })).toMatch("Emergency Stop");
    expect(v3SafetyGate({ ...ok, controls: { ...ok.controls, kill_switch: true } })).toMatch("Emergency Stop");
    expect(v3SafetyGate({ ...ok, controls: { ...ok.controls, consecutive_failures: 2 } })).toMatch("two-failure");
    expect(v3SafetyGate({ ...ok, todaySpendUsd: 5 })).toMatch("spending limit");
    expect(v3SafetyGate({ ...ok, todaySpendUsd: null })).toMatch("Spending limits");
    expect(v3SafetyGate({ ...ok, allowedRepos: [] })).toMatch("OMNI_ALLOWED_REPOS");
  });
  it("never invents a result", () => {
    expect(describeV3Job(null)).toMatchObject({ status: null, outcome: null, noResult: "No result came back from OMNI." });
    const base = { result_at: null, updated_at: "2026-11-10T01:00:00Z", last_source: "callback" };
    expect(describeV3Job({ ...base, status: "running", result: null })).toMatchObject({ outcome: null, summary: null, output: null });
    expect(describeV3Job({ ...base, status: "completed", result: null }).noResult).toBe("No result came back from OMNI.");
    const done = describeV3Job({
      ...base,
      status: "failed",
      result: { passed: false, summary: "1 failing", output: "FAIL x", truncated: true },
    });
    expect(done).toMatchObject({ outcome: "failed", summary: "1 failing", output: "FAIL x", truncated: true, noResult: null });
  });
});

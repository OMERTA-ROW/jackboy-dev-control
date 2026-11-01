import { describe, expect, it } from "vitest";
import { compatFromConfig, policyCheck, stateAfter } from "./update-policy";

const t = { channel: "test", platform: "web", current_version: "1.0.0", revoked: false };
const r = { status: "rolling", channel: "test", version: "1.1.0" };

describe("updater policy", () => {
  it("allows an owner-published compatible upgrade", () => expect(policyCheck(r, t)).toEqual({ allow: true, rollback: false, reasons: [] }));
  it("denies drafts (no owner approval)", () => expect(policyCheck({ ...r, status: "draft" }, t).allow).toBe(false));
  it("denies rolled-back releases", () => expect(policyCheck({ ...r, status: "rolled_back" }, t).allow).toBe(false));
  it("denies another channel", () => expect(policyCheck({ ...r, channel: "live" }, t).allow).toBe(false));
  it("denies revoked targets", () => expect(policyCheck(r, { ...t, revoked: true }).allow).toBe(false));
  it("denies unsupported platform", () => expect(policyCheck({ ...r, compatibility: { platforms: ["ios"] } }, t).allow).toBe(false));
  it("denies when current version is below min_from_version", () => expect(policyCheck({ ...r, compatibility: { min_from_version: "1.0.5" } }, t).allow).toBe(false));
  it("marks older target versions as rollback", () => expect(policyCheck({ ...r, version: "0.9.0" }, t).rollback).toBe(true));
  it("maps failed health to failed state", () => expect(stateAfter("failed")).toBe("failed"));
  it("reads compat from config", () => expect(compatFromConfig({ compat: { platforms: ["web"], min_from_version: "1.0.0" } })).toEqual({ platforms: ["web"], min_from_version: "1.0.0" }));
});

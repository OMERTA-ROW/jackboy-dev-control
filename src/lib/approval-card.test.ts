import { describe, expect, it, vi } from "vitest";
import { approvalCardLink, approvalCardView, canDecide } from "./action-approval";
import { codeApprovalError } from "./code";
import { loadApprovalCard, type CardClient } from "./approval-card.server";
import { draftAlert, resolvedAlertIds, safeLink } from "./owner-alerts";
import { KILL_SWITCH_ON, KILL_SWITCH_UNREADABLE } from "./global-pause";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const OWNER = "owner-1", OTHER = "owner-2";
const NONCE = "a".repeat(48);
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

type Tables = Record<string, Record<string, unknown> | null>;
function client(tables: Tables, role: unknown = "owner") {
  const writes: string[] = [];
  const sb = {
    rpc: vi.fn(async () => ({ data: role })),
    from(table: string) {
      const q = {
        select: () => q, eq: () => q, limit: () => q,
        maybeSingle: async () => (table in tables ? { data: tables[table], error: null } : { data: null, error: { message: "nope" } }),
        update: () => { writes.push(table); return q; }, insert: () => { writes.push(table); return q; },
        upsert: () => { writes.push(table); return q; }, delete: () => { writes.push(table); return q; },
      };
      return q;
    },
  };
  return { sb: sb as unknown as CardClient, writes };
}
const codeRow = (o: Record<string, unknown> = {}) => ({
  id: ID, task_id: null, action: "code_workflow", tier: "controlled", risk: "controlled", status: "pending", outcome: null,
  expires_at: future(), decided_at: null, requested_by: OWNER, permissions: ["Open a draft PR"], diff_summary: null,
  resources: { repo: "acme/site", instruction: "Fix the footer", taskBudgetUsd: 1, sessionHash: "s".repeat(64), correlation: ID }, ...o,
});
const noCode = { codeCard: vi.fn(async () => { throw new Error("should not be called"); }) };

describe("approval card deep links", () => {
  it("the link holds only the request id: no token, nonce or secret, and stays on this site", () => {
    const link = approvalCardLink(ID);
    expect(link).toBe(`/approvals/${ID}`);
    expect(safeLink(link)).toBe(link);
    expect(link).not.toMatch(/[?#&=]|nonce|token|secret|key/i);
    expect(link).not.toContain(NONCE);
    const alert = draftAlert("passkey_needed", `code:${ID}`, "CODE request waiting", "acme/site: waiting", link);
    expect(alert.link).toBe(link);
    // Anything that isn't a plain request id falls back to the general page, never carries extra data.
    expect(approvalCardLink(`${ID}?nonce=${NONCE}`)).toBe("/updates");
    expect(approvalCardLink("../../settings")).toBe("/updates");
  });

  it("other accounts and unknown ids get the same bare 'invalid' answer and nothing is written", async () => {
    const other = client({ action_requests: codeRow({ requested_by: OTHER }) });
    expect(await loadApprovalCard(other.sb, OWNER, ID, noCode)).toEqual({ state: "invalid" });
    const unknown = client({ action_requests: null });
    expect(await loadApprovalCard(unknown.sb, OWNER, ID, noCode)).toEqual({ state: "invalid" });
    const notOwner = client({ action_requests: codeRow() }, "member");
    expect(await loadApprovalCard(notOwner.sb, OWNER, ID, noCode)).toEqual({ state: "invalid" });
    expect(await loadApprovalCard(client({}).sb, OWNER, "not-an-id", noCode)).toEqual({ state: "invalid" });
    expect([...other.writes, ...unknown.writes, ...notOwner.writes]).toEqual([]);
    expect(approvalCardView({ status: "pending", expires_at: future(), requested_by: OTHER }, OWNER, null)).toEqual({ state: "invalid" });
  });

  it("expired links are no longer valid and change nothing", async () => {
    const c = client({ action_requests: codeRow({ expires_at: new Date(Date.now() - 1000).toISOString() }) });
    expect(await loadApprovalCard(c.sb, OWNER, ID, noCode)).toEqual({ state: "expired" });
    expect(c.writes).toEqual([]);
  });

  it("a pending card shows what runs, the cost cap and expiry, and never the session hash", async () => {
    const c = client({ action_requests: codeRow(), automation_policy: { paused: false } });
    const r = await loadApprovalCard(c.sb, OWNER, ID, noCode);
    expect(r.state).toBe("pending");
    if (r.state !== "pending") return;
    expect(r.card.whatRuns[0]).toBe("Fix the footer");
    expect(r.card.costCap).toContain("$1.00");
    expect(Date.parse(r.card.expiresAt)).toBeGreaterThan(Date.now());
    expect(r.decideBlocked).toBeNull();
    expect(JSON.stringify(r)).not.toContain("s".repeat(64));
    expect(c.writes).toEqual([]);
  });

  it("reuse after a decision is rejected: the card shows the outcome read from the run, not a decision path", async () => {
    const codeCard = vi.fn(async () => ({ id: ID, projectId: "p", repo: "acme/site", instruction: "x", status: "allowed", expiresAt: future(), permissions: [], outcome: "Accepted by GitHub; waiting for runner evidence",
      run: { id: 9, status: "completed", conclusion: "success", url: "https://github.com/acme/site/actions/runs/9", jobs: [], downloads: [], pr: "https://github.com/acme/site/pull/4" } }));
    const c = client({ action_requests: codeRow({ status: "allowed", decided_at: new Date().toISOString() }) });
    const r = await loadApprovalCard(c.sb, OWNER, ID, { codeCard });
    expect(r.state).toBe("decided");
    if (r.state !== "decided") return;
    expect(r.outcome.prUrl).toBe("https://github.com/acme/site/pull/4");
    expect(r.outcome.readFailed).toBe(false);
    expect(c.writes).toEqual([]);
    // The existing decision rules still refuse a second decision.
    const decided = { status: "allowed", expires_at: future(), requested_by: OWNER };
    expect(canDecide({ ...decided, tier: "controlled" }, OWNER, "allow_once", true)).toMatch(/Already/);
    expect(codeApprovalError({ ...decided, resources: codeRow().resources as never }, OWNER, "s".repeat(64))).toMatch(/already been decided/);
  });

  it("an unreadable run is reported as unread, never as success", async () => {
    const c = client({ action_requests: codeRow({ status: "allowed" }) });
    const r = await loadApprovalCard(c.sb, OWNER, ID, { codeCard: async () => { throw new Error("GitHub down"); } });
    expect(r.state === "decided" && r.outcome.readFailed && r.outcome.prUrl === null).toBe(true);
  });

  it("Kill Switch on (or unreadable) keeps approvals blocked", async () => {
    const on = await loadApprovalCard(client({ action_requests: codeRow(), automation_policy: { paused: true } }).sb, OWNER, ID, noCode);
    expect(on.state === "pending" && on.decideBlocked).toBe(KILL_SWITCH_ON);
    const unreadable = await loadApprovalCard(client({ action_requests: codeRow() }).sb, OWNER, ID, noCode);
    expect(unreadable.state === "pending" && unreadable.decideBlocked).toBe(KILL_SWITCH_UNREADABLE);
  });

  it("after a decision the waiting alert resolves: unsent alerts are dropped, but not when a source failed to read", () => {
    const queued = [
      { id: "a1", dedupeKey: `passkey_needed:code:${ID}`, kind: "passkey_needed" as const },
      { id: "a2", dedupeKey: `passkey_needed:code:${ID}:reminder`, kind: "passkey_needed" as const },
      { id: "a3", dedupeKey: "passkey_needed:action:still-open", kind: "passkey_needed" as const },
    ];
    const waiting = new Set(["passkey_needed:action:still-open"]);
    expect(resolvedAlertIds(queued, waiting, true)).toEqual(["a1", "a2"]);
    expect(resolvedAlertIds(queued, waiting, false)).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  owner: "owner" as string | null,
  auditFails: false,
  missing: "",
  rows: {} as Record<string, Record<string, unknown>[]>,
  reads: [] as string[],
  writes: [] as unknown[],
  slow: false,
}));
vi.mock("./chat.server", () => ({ verifyOwner: vi.fn(async () => mock.owner) }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      let filter: [string, unknown] | null = null;
      const query = {
        select() {
          mock.reads.push(table);
          return query;
        },
        limit() {
          return query;
        },
        eq(key: string, value: unknown) {
          filter = [key, value];
          return query;
        },
        insert(value: unknown) {
          mock.writes.push({ table, value });
          return Promise.resolve({ error: mock.auditFails ? {} : null });
        },
        then(resolve: (value: unknown) => unknown) {
          if (mock.slow) vi.setSystemTime(Date.now() + 61_000);
          let rows = mock.rows[table] ?? [];
          if (filter) rows = rows.filter((r) => r[filter![0]] === filter![1]);
          return Promise.resolve({
            data: rows,
            count: rows.length,
            error: mock.missing === table ? {} : null,
          }).then(resolve);
        },
      };
      return query;
    },
  },
}));
import { handleSafetyStatus } from "./safety-status.server";
const request = (suffix = "") =>
  new Request(`https://example.test/api/safety-status${suffix}`, {
    headers: { Authorization: "Bearer private-test-token" },
  });
beforeEach(() => {
  vi.useRealTimers();
  Object.assign(mock, {
    owner: "owner",
    auditFails: false,
    missing: "",
    reads: [],
    writes: [],
    slow: false,
    rows: {
      update_writer_settings: [{ id: 1, autopilot_enabled: false }],
      owner_projects: [
        {
          id: "p",
          github_repo: "OMERTA-ROW/jackboy-dev-control",
          autopilot: false,
          dev_enabled: false,
        },
      ],
      foundry_schedule: [{ id: 1, enabled: false, paused: true }],
      code_runtime_controls: [
        { singleton: true, enabled: false, kill_switch: true, active_request_id: null },
      ],
    },
  });
});
describe("owner-only observational safety status", () => {
  it("denies nonowners before reads and audits no credentials", async () => {
    mock.owner = null;
    expect((await handleSafetyStatus(request())).status).toBe(401);
    expect(mock.reads).toEqual([]);
    expect(JSON.stringify(mock.writes)).not.toContain("private-test-token");
    expect(mock.writes).toHaveLength(1);
  });
  it("fails closed before reads when audit fails", async () => {
    mock.auditFails = true;
    expect((await handleSafetyStatus(request())).status).toBe(503);
    expect(mock.reads).toEqual([]);
  });
  it("returns selected states, blocks incomplete coverage and writes only an access audit", async () => {
    const response = await handleSafetyStatus(request());
    const body = await response.json();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body.evidence.code.status).toBe("PASS");
    expect(body.evidence.workers.status).toBe("BLOCKED");
    expect(body.evidence.audit.status).toBe("BLOCKED");
    expect(body.status).toBe("BLOCKED");
    expect(body.activationApproved).toBe(false);
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0]).toMatchObject({ table: "audit_logs" });
  });
  it("reports missing table and singleton as unknown, never safe", async () => {
    mock.missing = "code_runtime_controls";
    mock.rows["update_writer_settings"] = [];
    const body = await (await handleSafetyStatus(request())).json();
    expect(body.evidence.code).toMatchObject({ status: "BLOCKED", values: null });
    expect(body.evidence.masterAutopilot.status).toBe("BLOCKED");
  });
  it("refuses supplied scope and cannot use another project as evidence", async () => {
    expect((await handleSafetyStatus(request("?project=other"))).status).toBe(400);
    mock.rows["owner_projects"] = [
      { github_repo: "other/repo", autopilot: false, dev_enabled: false },
    ];
    const body = await (await handleSafetyStatus(request())).json();
    expect(body.evidence.project.status).toBe("BLOCKED");
  });
  it("detects unsafe controls and unreviewed queued jobs", async () => {
    mock.rows["code_runtime_controls"]![0]!["kill_switch"] = false;
    mock.rows["omni_jobs"] = [{ id: "job", status: "queued" }];
    const body = await (await handleSafetyStatus(request())).json();
    expect(body.status).toBe("FAIL");
    expect(body.evidence.code.status).toBe("FAIL");
    expect(body.evidence.omniQueue.values.requiringApprovalReview).toBe(1);
  });
  it("blocks malformed controls and recognizes the actual CODE action", async () => {
    mock.rows["code_runtime_controls"]![0]!["enabled"] = null;
    mock.rows["action_requests"] = [
      {
        id: "r",
        action: "code_workflow",
        status: "allowed",
        runner_claimed_at: null,
        runner_published_at: null,
      },
    ];
    const body = await (await handleSafetyStatus(request())).json();
    expect(body.evidence.code).toMatchObject({ status: "BLOCKED", values: null });
    expect(body.evidence.requests.values.requiringLifecycleReview).toBe(1);
  });
  it("blocks truncated inventories and slow/stale snapshots", async () => {
    mock.rows["omni_jobs"] = Array.from({ length: 501 }, () => ({
      id: "job",
      status: "completed",
    }));
    let body = await (await handleSafetyStatus(request())).json();
    expect(body.evidence.omniQueue).toMatchObject({
      status: "BLOCKED",
      coverage: "partial",
      values: null,
    });
    vi.useFakeTimers();
    mock.slow = true;
    body = await (await handleSafetyStatus(request())).json();
    expect(body.evidence.code).toMatchObject({ status: "BLOCKED", values: null });
    vi.useRealTimers();
  });
});

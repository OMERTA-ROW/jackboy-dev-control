import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal stand-in for the admin client: every query resolves from `answers` by table,
// and writes are recorded so tests can prove what did (and did not) change.
type Answer = { data?: unknown; count?: number | null; error?: unknown };
const answers: Record<string, Answer> = {};
const writes: Array<{ table: string; op: string; value: unknown }> = [];

function query(table: string) {
  let updated = false;
  const result = () => (updated ? { data: [{ id: "updated" }], error: null } : answers[table] ?? { data: null, count: 0, error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "in", "order", "limit"]) chain[m] = () => chain;
  chain["maybeSingle"] = async () => result();
  chain["update"] = (value: unknown) => { writes.push({ table, op: "update", value }); updated = true; return chain; };
  chain["insert"] = async (value: unknown) => { writes.push({ table, op: "insert", value }); return { error: null }; };
  chain["then"] = (resolve: (v: Answer) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => query(table) },
}));

const release = { id: "rel-1", project_id: "proj-1", version: "1.2.0", channel: "live", status: "rolling", error_threshold: 5, min_reports: 1, published_at: null };

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  writes.length = 0;
  answers["releases"] = { data: release };
  answers["owner_projects"] = { data: { name: "Demo" } };
});

describe("release health assessment", () => {
  it("forged public failure reports never roll a release back; they alert the owner once and hold rollout", async () => {
    const { assessRelease } = await import("./update-server.server");
    answers["update_installs"] = { data: [] };
    answers["health_reports"] = { count: 500 }; // 500 of 500 "failed" from invented device ids
    answers["audit_logs"] = { count: 0 };
    const out = await assessRelease("rel-1");
    expect(out).toEqual({ rolledBack: false, held: true });
    expect(writes.some((w) => w.table === "releases" && w.op === "update")).toBe(false);
    expect(writes.find((w) => w.table === "audit_logs")?.value).toMatchObject({ action: "releases.health_alert", outcome: "held" });
  });

  it("does not repeat the owner alert for the same release", async () => {
    const { assessRelease } = await import("./update-server.server");
    answers["update_installs"] = { data: [] };
    answers["health_reports"] = { count: 50 };
    answers["audit_logs"] = { count: 1 };
    expect(await assessRelease("rel-1")).toEqual({ rolledBack: false, held: true });
    expect(writes).toEqual([]);
  });

  it("enrolled-target failures still roll back automatically", async () => {
    const { assessRelease } = await import("./update-server.server");
    answers["update_installs"] = { data: [{ target_id: "t1", phase: "failed" }] };
    const out = await assessRelease("rel-1");
    expect(out.rolledBack).toBe(true);
    expect(writes.find((w) => w.table === "releases")?.value).toMatchObject({ status: "rolled_back", rollout_percent: 0 });
  });

  it("an unreadable target history never counts as rollback evidence", async () => {
    const { assessRelease } = await import("./update-server.server");
    answers["update_installs"] = { data: null, error: { message: "boom" } };
    answers["health_reports"] = { count: 0 };
    expect(await assessRelease("rel-1")).toEqual({ rolledBack: false, held: false });
    expect(writes).toEqual([]);
  });
});

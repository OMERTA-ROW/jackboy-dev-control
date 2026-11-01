import { describe, expect, it } from "vitest";
import { eligible, runBounded, sanitizeSelection } from "./batch";

const p = { id: "p1", name: "A", site_url: "https://a.test", lovable_url: null, github_repo: "o/r" };
const scan = (findings: unknown[]) => ({ project_id: "p1", status: "done", findings, created_at: "x", error: null });

describe("batch eligibility", () => {
  it("skips scan without site address", () => expect(eligible("scan", { ...p, site_url: null }, undefined, [])).toEqual({ ok: false, reason: "Add a site address first" }));
  it("allows scan with site address", () => expect(eligible("scan", p, undefined, []).ok).toBe(true));
  it("repair needs a finished scan", () => expect(eligible("repair", p, undefined, []).ok).toBe(false));
  it("repair ignores low-only findings", () => expect(eligible("repair", p, scan([{ severity: "low" }]), []).ok).toBe(false));
  it("repair allowed with medium finding", () => expect(eligible("repair", p, scan([{ severity: "medium" }]), []).ok).toBe(true));
  it("distribute needs a repo", () => expect(eligible("distribute", { ...p, github_repo: null }, undefined, []).ok).toBe(false));
  it("distribute needs an approved undelivered update", () => {
    expect(eligible("distribute", p, undefined, [{ id: "u", project_id: "p1", status: "approved", pr_url: "x" }]).ok).toBe(false);
    expect(eligible("distribute", p, undefined, [{ id: "u", project_id: "p1", status: "approved", pr_url: null }]).ok).toBe(true);
  });
  it("never uses another project's approvals", () => expect(eligible("distribute", p, undefined, [{ id: "u", project_id: "p2", status: "approved", pr_url: null }]).ok).toBe(false));
});

describe("selection and bounded queue", () => {
  it("drops unknown and duplicate ids", () => expect(sanitizeSelection(["a", "a", "z", 3], ["a", "b"])).toEqual(["a"]));
  it("never exceeds the concurrency limit and isolates failures", async () => {
    let live = 0, peak = 0;
    const r = await runBounded([1, 2, 3, 4, 5], 2, async (n) => { live++; peak = Math.max(peak, live); await new Promise((x) => setTimeout(x, 5)); live--; if (n === 3) throw new Error("boom"); return n; });
    expect(peak).toBe(2);
    expect(r[2]).toEqual({ ok: false, error: "boom" });
    expect(r[4]).toEqual({ ok: true, value: 5 });
  });
});

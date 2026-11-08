import { describe, expect, it } from "vitest";
import { backgroundState, bulkPlan, loopResult, loopStep, type ConnectRow } from "./connect-select";
import { connectButtonLabel } from "./project-hub";

const row = (o: Partial<ConnectRow>): ConnectRow => ({ key: "p:1", name: "OMNI", projectId: "1", lovableRef: null, repo: "o/omni", status: "repo_linked", devEnabled: false, detail: "", ...o });

describe("connect button state", () => {
  it("a healthy linked repo shows Connected, not Reconnect", () => {
    expect(connectButtonLabel({ github_repo: "o/omni" }, "ok")).toBe("Connected");
    expect(connectButtonLabel({ github_repo: "o/omni" }, "warn")).toBe("Connected");
  });
  it("Reconnect only when the connection is actually broken", () => {
    expect(connectButtonLabel({ github_repo: "o/omni", repo_sync_status: "deleted" })).toBe("Reconnect");
    expect(connectButtonLabel({ github_repo: "o/omni", connect_state: "error" })).toBe("Reconnect");
    expect(connectButtonLabel({ github_repo: "o/omni" }, "error")).toBe("Reconnect");
  });
  it("no repo yet shows Connect", () => {
    expect(connectButtonLabel({ github_repo: null })).toBe("Connect");
  });
});

describe("background work state", () => {
  it("activated + connected is active, and Activate is not offered again", () => {
    const r = row({ devEnabled: true });
    expect(backgroundState(r)).toBe("active");
    const plan = bulkPlan([r]);
    expect(plan.activate).toHaveLength(0);
    expect(plan.connect).toHaveLength(0);
    expect(plan.deactivate).toHaveLength(1);
  });
  it("a disconnected project needs Reconnect before Activate comes back", () => {
    const r = row({ status: "repo_error", devEnabled: true });
    expect(backgroundState(r)).toBe("needs_reconnect");
    const plan = bulkPlan([r]);
    expect(plan.activate).toHaveLength(0);
    expect(plan.connect).toHaveLength(1);
  });
  it("after a reconnect (background off) Activate is offered", () => {
    expect(bulkPlan([row({ devEnabled: false })]).activate).toHaveLength(1);
  });
});

describe("coding loop progress", () => {
  it("shows the server's real milestones in order", () => {
    expect(loopStep([])).toBe("Opening the repository…");
    const started = { project_id: "1", action: "inspect_started", to_state: null, note: "Reading 51 files in o/omni; checking 40 source file(s)…", created_at: "" };
    expect(loopStep([started])).toContain("Reading 51 files");
    expect(loopStep([started, { ...started, action: "transition", to_state: "analyzing", note: "x" }])).toBe("Writing a minimal fix…");
  });
  it("finishes with the real result", () => {
    expect(loopResult({ created: 0, inspectedFiles: 51 })).toEqual({ phase: "done", text: "Inspected 51 files; nothing new to fix" });
    expect(loopResult({ created: 0, blocked: "No GitHub repo linked to this project." }).phase).toBe("blocked");
  });
});

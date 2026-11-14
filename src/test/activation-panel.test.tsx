import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  pauseAll: vi.fn(),
  resume: vi.fn(),
  setHardCap: vi.fn(),
  setEnabled: vi.fn(),
  release: vi.fn(),
  stepUp: vi.fn(),
  omniState: vi.fn(),
  omniReconcile: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/code-safety.functions", () => ({
  engageCodeKillSwitch: mocks.stop,
  resumeJackboyWork: mocks.resume,
  stopJackboyWork: mocks.pauseAll,
  setCodeHardCapVerified: mocks.setHardCap,
  getUnifiedOmniState: mocks.omniState,
  reconcileOmniCancellation: mocks.omniReconcile,
  setCodeEnabled: mocks.setEnabled,
  releaseCodeEmergencyStop: mocks.release,
}));
vi.mock("@/components/ReadinessChecks", () => ({ ReadinessChecks: () => null }));
vi.mock("@/lib/step-up-client", () => ({ useStepUp: () => mocks.stepUp }));
import { ActivationPanel, type ActivationState } from "@/components/ActivationPanel";
import {
  CODE_DISABLE_TARGET,
  CODE_ENABLE_TARGET,
  CODE_STOP_RELEASE_TARGET,
} from "@/lib/code-safety";

const GRANT = "11111111-1111-4111-8111-111111111111";
const IDS = [
  "no_task",
  "failures",
  "spike",
  "cancellation",
  "hard_cap",
  "total_guard",
  "meter",
  "pins",
  "gateway",
  "cost_check",
];
const RELEASE_IDS = ["no_task", "failures", "spike", "cancellation", "hard_cap", "total_guard"];
const gates = (failing: string[] = [], ids = IDS) =>
  ids.map((id) => ({ id, label: id, ok: !failing.includes(id), detail: "" }));
const OFF: ActivationState = {
  enabled: false,
  killSwitch: true,
  activeRequestId: null,
  activeRunId: null,
  providerBudgetEnforced: true,
  totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 0 } as never,
};
const ALL_ON: ActivationState = { ...OFF, enabled: true, killSwitch: false };
const run = async (action: () => Promise<unknown>) => {
  await action();
};
type P = Partial<Parameters<typeof ActivationPanel>[0]>;
const panel = (p: P = {}) => (
  <ActivationPanel
    state={OFF}
    gates={gates()}
    releaseGates={gates([], RELEASE_IDS)}
    independent
    globalPaused
    gatesError={null}
    busy={false}
    run={run}
    {...p}
  />
);
const controls = () => within(screen.getByLabelText("Safety controls"));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.omniState.mockResolvedValue({ state: null, label: "Blocked" });
  mocks.stop.mockResolvedValue({ omniCancellation: { pending: 0, unavailable: 0 } });
  mocks.stepUp.mockImplementation(
    async (
      _a: string,
      _t: string,
      o?: { apply?: (g: string) => Promise<unknown>; doneText?: (r: unknown) => string },
    ) => {
      if (!o?.apply) return GRANT;
      const r = await o.apply(GRANT);
      o.doneText?.(r);
      return r;
    },
  );
  mocks.setEnabled.mockResolvedValue({ control: "code_enabled", ok: true, message: "saved" });
  mocks.release.mockResolvedValue({
    control: "emergency_stop_release",
    ok: true,
    message: "released",
  });
});
afterEach(cleanup);

describe("three independent safety controls", () => {
  it("shows Kill Switch, saved CODE setting and Emergency Stop separately, plus whether CODE can run", () => {
    render(panel());
    const c = controls();
    expect(c.getByRole("heading", { name: /System Kill Switch/ })).toBeInTheDocument();
    expect(c.getByRole("heading", { name: /CODE enabled \(saved setting\)/ })).toBeInTheDocument();
    expect(c.getByRole("heading", { name: /CODE Emergency Stop/ })).toBeInTheDocument();
    expect(c.getByText(/Can CODE run right now\?/).parentElement).toHaveTextContent(
      "Saved CODE setting: OFF · Can CODE run right now? No — Kill Switch is on · CODE Emergency Stop is engaged · CODE is saved as OFF.",
    );
  });

  it("CODE can be saved as ON while the Kill Switch and the stop are on, with its own fresh passkey and nothing else", async () => {
    render(panel());
    const codeSwitch = controls().getByRole("switch", { name: "CODE enabled" });
    expect(codeSwitch).toBeEnabled();
    fireEvent.click(codeSwitch);
    await waitFor(() =>
      expect(mocks.setEnabled).toHaveBeenCalledWith({ data: { grantId: GRANT, enabled: true } }),
    );
    expect(mocks.stepUp).toHaveBeenCalledWith("code_enable", CODE_ENABLE_TARGET, expect.anything());
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("turning CODE off uses its own off passkey and never engages the Emergency Stop", async () => {
    render(panel({ state: ALL_ON, globalPaused: false }));
    const codeSwitch = controls().getByRole("switch", { name: "CODE enabled" });
    expect(codeSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(codeSwitch);
    await waitFor(() =>
      expect(mocks.setEnabled).toHaveBeenCalledWith({ data: { grantId: GRANT, enabled: false } }),
    );
    expect(mocks.stepUp).toHaveBeenCalledWith(
      "code_enable",
      CODE_DISABLE_TARGET,
      expect.anything(),
    );
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.pauseAll).not.toHaveBeenCalled();
  });

  it("the Emergency Stop has its own release with its own fresh passkey; it never turns CODE on", async () => {
    render(panel());
    fireEvent.click(controls().getByRole("button", { name: "Release emergency stop" }));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
    expect(mocks.stepUp).toHaveBeenCalledWith(
      "code_stop_release",
      CODE_STOP_RELEASE_TARGET,
      expect.anything(),
    );
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("a failing release requirement locks the release and lists why; engage stays available elsewhere", () => {
    render(panel({ releaseGates: gates(["spike"], RELEASE_IDS) }));
    expect(controls().getByRole("button", { name: "Release emergency stop" })).toBeDisabled();
    expect(controls().getByText(/Release locked: 1 requirement is not met/)).toBeInTheDocument();
    expect(
      within(controls().getByLabelText("Release requirements not met")).getByText(/Needs: spike/),
    ).toBeInTheDocument();
  });

  it("engaging the Emergency Stop works with CODE disabled and while the Kill Switch is on", async () => {
    render(panel({ state: { ...OFF, killSwitch: false } }));
    fireEvent.click(controls().getByRole("button", { name: "Engage emergency stop" }));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
    expect(mocks.stepUp).toHaveBeenCalledWith("global_pause", "global_pause:on", expect.anything());
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("the Kill Switch buttons call only the Kill Switch actions", async () => {
    mocks.pauseAll.mockResolvedValue({ paused: true, warning: "New work is blocked." });
    const { rerender } = render(panel({ globalPaused: false }));
    fireEvent.click(controls().getByRole("button", { name: "Turn Kill Switch on" }));
    await waitFor(() => expect(mocks.pauseAll).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
    rerender(panel({ globalPaused: true }));
    fireEvent.click(controls().getByRole("button", { name: "Turn Kill Switch off" }));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
    expect(mocks.stepUp).toHaveBeenCalledWith(
      "global_pause",
      "global_pause:off",
      expect.anything(),
    );
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("a failing requirement keeps the CODE switch locked with the reason listed", () => {
    render(panel({ gates: gates(["pins"]) }));
    const codeSwitch = controls().getByRole("switch", { name: "CODE enabled" });
    expect(codeSwitch).toBeDisabled();
    expect(controls().getByText("Locked: 1 requirement is not met.")).toBeInTheDocument();
    fireEvent.click(codeSwitch);
    expect(mocks.stepUp).not.toHaveBeenCalled();
  });

  it("until the database change is installed, CODE and release are locked with the reason, and the stop still engages", async () => {
    render(panel({ independent: false, state: { ...OFF, killSwitch: false } }));
    expect(controls().getByRole("switch", { name: "CODE enabled" })).toBeDisabled();
    expect(controls().getByText(/database update .* not installed yet/)).toBeInTheDocument();
    fireEvent.click(controls().getByRole("button", { name: "Engage emergency stop" }));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    cleanup();
    render(panel({ independent: null }));
    expect(controls().getByRole("button", { name: "Release emergency stop" })).toBeDisabled();
  });

  it("unreadable state: Emergency Stop stays pressable, everything else is locked", () => {
    render(panel({ state: null, gates: null, releaseGates: null, globalPaused: null }));
    expect(controls().getByRole("button", { name: "Engage emergency stop" })).toBeEnabled();
    expect(controls().getByRole("switch", { name: "CODE enabled" })).toBeDisabled();
    expect(controls().getByRole("button", { name: "Turn Kill Switch on" })).toBeDisabled();
  });

  it("a cancelled passkey changes nothing", async () => {
    mocks.stepUp.mockRejectedValue(new Error("Passkey cancelled"));
    const errors: unknown[] = [];
    render(
      panel({
        run: (a) =>
          a().then(
            () => {},
            (e) => void errors.push(e),
          ),
      }),
    );
    fireEvent.click(controls().getByRole("switch", { name: "CODE enabled" }));
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("failures are shown as alerts, not as success", () => {
    render(
      panel({
        message: "The database refused to turn CODE on; nothing changed.",
        messageTone: "error",
      }),
    );
    expect(screen.getByText(/^Not done: The database refused/)).toHaveAttribute("role", "alert");
  });
});

describe("activation walkthrough", () => {
  it("does not claim completion when independent controls cannot be verified", () => {
    render(panel({ state: ALL_ON, globalPaused: false, independent: null }));
    expect(screen.queryByText(/Activation complete/)).toBeNull();
    expect(controls().getByText(/Independent safety controls not verified/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start activation" }));
    expect(screen.getByText(/Activation status blocked/)).toBeInTheDocument();
    expect(screen.queryByText(/Activation complete/)).toBeNull();
    expect(mocks.stepUp).not.toHaveBeenCalled();
  });
  it("starts only on press, shows one step, and advances after a fresh read without pressing anything", async () => {
    const { rerender } = render(
      panel({ state: { ...OFF, providerBudgetEnforced: false }, gates: gates(["hard_cap"]) }),
    );
    expect(screen.queryByLabelText("Activation walkthrough")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start activation" }));
    expect(screen.getByText("Step 4 of 8")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Provider hard cap confirmed" }),
    ).toBeInTheDocument();
    rerender(panel());
    expect(
      await screen.findByText("Step 4 done: Provider hard cap confirmed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Step 6 of 8")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Activation walkthrough")).getByRole("button", {
        name: "Turn Kill Switch off with passkey",
      }),
    ).toBeInTheDocument();
    expect(mocks.stepUp).not.toHaveBeenCalled();
  });

  it("a blocked step explains why and how to fix it, offering only Check again", () => {
    render(
      panel({
        gates: gates(["pins"]).map((g) =>
          g.id === "pins" ? { ...g, detail: "Pins differ; resync first." } : g,
        ),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start activation" }));
    const w = within(screen.getByLabelText("Activation walkthrough"));
    expect(w.getByText("Status: blocked")).toBeInTheDocument();
    expect(w.getByText("Why: Pins differ; resync first.")).toBeInTheDocument();
    expect(w.getByText(/How to fix: .*pin resync/)).toBeInTheDocument();
    expect(w.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("complete only when all three controls allow work; folds away but keeps the stop reachable", async () => {
    const { rerender } = render(panel({ state: ALL_ON, globalPaused: true }));
    expect(screen.queryByText(/Activation complete/)).toBeNull();
    rerender(panel({ state: ALL_ON, globalPaused: false }));
    expect(screen.getByText(/Activation complete/)).toBeInTheDocument();
    expect(screen.getByText("Show activation steps").closest("details")).not.toHaveAttribute(
      "open",
    );
    fireEvent.click(controls().getByRole("button", { name: "Engage emergency stop" }));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
  });

  it("release and turn-on steps use their own actions", async () => {
    render(panel({ globalPaused: false }));
    fireEvent.click(screen.getByRole("button", { name: "Release emergency stop with passkey" }));
    await waitFor(() => expect(mocks.release).toHaveBeenCalled());
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    cleanup();
    render(panel({ globalPaused: false, state: { ...OFF, killSwitch: false } }));
    fireEvent.click(screen.getByRole("button", { name: "Turn CODE on with passkey" }));
    await waitFor(() =>
      expect(mocks.setEnabled).toHaveBeenCalledWith({ data: { grantId: GRANT, enabled: true } }),
    );
  });
});

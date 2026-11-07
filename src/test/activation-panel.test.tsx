import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  resume: vi.fn(),
  setHardCap: vi.fn(),
  enable: vi.fn(),
  stepUp: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/code-safety.functions", () => ({
  engageCodeKillSwitch: mocks.stop,
  resumeJackboyWork: mocks.resume,
  setCodeHardCapVerified: mocks.setHardCap,
  enableCodeRuntime: mocks.enable,
}));
vi.mock("@/lib/step-up-client", () => ({ useStepUp: () => mocks.stepUp }));
import { ActivationPanel, type ActivationState } from "@/components/ActivationPanel";
import { CODE_ENABLE_TARGET } from "@/lib/code-safety";

const GRANT = "11111111-1111-4111-8111-111111111111";
const IDS = [
  "stopped",
  "no_task",
  "failures",
  "spike",
  "cancellation",
  "hard_cap",
  "total_guard",
  "meter",
  "global_pause",
  "pins",
  "gateway",
  "cost_check",
];
const gates = (failing: string[] = []) =>
  IDS.map((id) => ({
    id,
    label: id,
    ok: !failing.includes(id),
    detail:
      id === "global_pause" && failing.includes(id)
        ? "Turn the global pause off first (needs a passkey)."
        : "",
  }));
const OFF: ActivationState = {
  enabled: false,
  killSwitch: true,
  activeRequestId: null,
  activeRunId: null,
  providerBudgetEnforced: true,
  totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 0 } as never,
};
const run = async (action: () => Promise<unknown>) => {
  await action();
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.stepUp.mockResolvedValue(GRANT);
});
afterEach(cleanup);

it("turning CODE on uses the same fresh passkey action and stays disabled until every check passes", async () => {
  const { rerender } = render(
    <ActivationPanel
      state={OFF}
      gates={gates(["global_pause"])}
      gatesError={null}
      busy={false}
      run={run}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Release CODE stop and turn CODE on with passkey" }),
  ).toBeDisabled();
  rerender(
    <ActivationPanel state={OFF} gates={gates()} gatesError={null} busy={false} run={run} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Release CODE stop and turn CODE on with passkey" }),
  );
  await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
  expect(mocks.stepUp).toHaveBeenCalledWith("code_enable", CODE_ENABLE_TARGET);
});

it("the global pause step asks for the passkey bound to the off action", async () => {
  render(
    <ActivationPanel
      state={OFF}
      gates={gates(["global_pause"])}
      gatesError={null}
      busy={false}
      run={run}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn global pause off with passkey" }));
  await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
  expect(mocks.stepUp).toHaveBeenCalledWith("global_pause", "global_pause:off");
});

it("folds the steps away once CODE is on but keeps the emergency stop reachable", async () => {
  const on = { ...OFF, enabled: true, killSwitch: false };
  render(
    <ActivationPanel
      state={on}
      gates={gates(["stopped"])}
      gatesError={null}
      busy={false}
      run={run}
    />,
  );
  expect(screen.getByText(/Activation complete/)).toBeInTheDocument();
  expect(screen.getByText("Show activation steps").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Engage emergency stop" }));
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
  expect(mocks.stepUp).toHaveBeenCalledWith("global_pause", "global_pause:on");
});

it("a cancelled passkey changes nothing", async () => {
  mocks.stepUp.mockRejectedValue(new Error("Passkey cancelled"));
  const errors: unknown[] = [];
  render(
    <ActivationPanel
      state={OFF}
      gates={gates()}
      gatesError={null}
      busy={false}
      run={(a) =>
        a().then(
          () => {},
          (e) => {
            errors.push(e);
          },
        )
      }
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Release CODE stop and turn CODE on with passkey" }),
  );
  await waitFor(() => expect(errors).toHaveLength(1));
  expect(mocks.enable).not.toHaveBeenCalled();
});

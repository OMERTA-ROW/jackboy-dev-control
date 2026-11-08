import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), test: vi.fn(), gateway: vi.fn(), pkOptions: vi.fn(), pkVerify: vi.fn(), requestPasskey: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/readiness.functions", () => ({ getReadiness: mocks.load, testReadiness: mocks.test }));
vi.mock("@/lib/code-safety.functions", () => ({ testCodeProviderGateway: mocks.gateway }));
vi.mock("@/lib/passkey.functions", () => ({ passkeyTestOptions: mocks.pkOptions, passkeyTestVerify: mocks.pkVerify }));
vi.mock("@/lib/passkey-prompt", () => ({ requestPasskey: mocks.requestPasskey }));
import { ReadinessChecks } from "@/components/ReadinessChecks";
import { READINESS } from "@/lib/readiness";

const items = Object.fromEntries(READINESS.map((r) => [r.id, { status: "NOT TESTED", reason: "No test yet.", at: "", source: "test" }]));
const props = { busy: false, onEmergencyStop: vi.fn(), onStartActivation: vi.fn(), emergencyStopEngaged: true };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({ checkedAt: "", items });
  mocks.test.mockResolvedValue({});
  mocks.gateway.mockResolvedValue({});
  mocks.requestPasskey.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

it("loading the list never runs a test by itself", async () => {
  render(<ReadinessChecks {...props} />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalled());
  expect(mocks.test).not.toHaveBeenCalled();
  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.requestPasskey).not.toHaveBeenCalled();
});

it("Test runs that item's server check and then re-reads the status", async () => {
  render(<ReadinessChecks {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Test OMNI pull requests" }));
  await waitFor(() => expect(mocks.test).toHaveBeenCalledWith({ data: { item: "omni_prs" } }));
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
});

it("the gateway and passkey items use their own checks", async () => {
  render(<ReadinessChecks {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Test Provider gateway" }));
  await waitFor(() => expect(mocks.gateway).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Test Physical-device passkey" }));
  await waitFor(() => expect(mocks.requestPasskey).toHaveBeenCalled());
  expect(mocks.test).not.toHaveBeenCalled();
});

it("Test all skips the passkey, which always needs your own tap", async () => {
  render(<ReadinessChecks {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Test all" }));
  await waitFor(() => expect(mocks.test).toHaveBeenCalledTimes(10));
  expect(mocks.gateway).toHaveBeenCalledTimes(1);
  expect(mocks.requestPasskey).not.toHaveBeenCalled();
});

it("Block uses the emergency stop and Unblock opens the activation walkthrough", async () => {
  const onEmergencyStop = vi.fn(), onStartActivation = vi.fn();
  render(<ReadinessChecks {...props} emergencyStopEngaged={false} onEmergencyStop={onEmergencyStop} onStartActivation={onStartActivation} />);
  fireEvent.click(await screen.findByRole("button", { name: "Block CODE on/off controls" }));
  expect(onEmergencyStop).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Unblock Spending limits enforced" }));
  expect(onStartActivation).toHaveBeenCalledOnce();
});

it("re-reads when another control in the panel finishes", async () => {
  const { rerender } = render(<ReadinessChecks {...props} busy />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
  rerender(<ReadinessChecks {...props} busy={false} />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
});

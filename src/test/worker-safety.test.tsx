import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ stop: vi.fn(), resume: vi.fn(), load: vi.fn(), stepUp: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/lib/code-safety.functions", () => ({ stopJackboyWork: mocks.stop, resumeJackboyWork: mocks.resume }));
vi.mock("@/lib/automation.functions", () => ({ getAutomation: mocks.load }));
vi.mock("@/lib/step-up-client", () => ({ useStepUp: () => mocks.stepUp }));
import { WorkerSafetyBar } from "@/components/WorkerSafetyBar";
const GRANT = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.resetAllMocks(); mocks.load.mockResolvedValue({ role: "owner", policy: { paused: false } }); mocks.stepUp.mockResolvedValue(GRANT); });
afterEach(cleanup);
it("turning the Kill Switch on asks for a passkey first, then stops with that grant", async () => {
  mocks.stop.mockResolvedValue({ warning: "New work blocked; external cancellation unconfirmed." });
  render(<WorkerSafetyBar />);
  fireEvent.click(await screen.findByRole("button", { name: "Turn Kill Switch on" }));
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
  expect(mocks.stepUp).toHaveBeenCalledWith("global_pause", "global_pause:on");
});
it("turning it off asks for a passkey bound to the off action", async () => {
  mocks.load.mockResolvedValue({ role: "owner", policy: { paused: true } });
  mocks.resume.mockResolvedValue({ paused: false });
  render(<WorkerSafetyBar />);
  fireEvent.click(await screen.findByRole("button", { name: "Turn Kill Switch off" }));
  await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ data: { grantId: GRANT } }));
  expect(mocks.stepUp).toHaveBeenCalledWith("global_pause", "global_pause:off");
});
it("a cancelled passkey changes nothing", async () => {
  mocks.stepUp.mockRejectedValue(new Error("Passkey cancelled"));
  render(<WorkerSafetyBar />);
  fireEvent.click(await screen.findByRole("button", { name: "Turn Kill Switch on" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Passkey cancelled");
  expect(mocks.stop).not.toHaveBeenCalled();
});
it("does not offer worker controls to a member", async () => {
  mocks.load.mockResolvedValue({ role: "member", policy: { paused: false } });
  render(<WorkerSafetyBar />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalled());
  expect(screen.queryByRole("button")).toBeNull();
});

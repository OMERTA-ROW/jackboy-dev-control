import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ stop: vi.fn(), load: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/lib/code-safety.functions", () => ({ stopJackboyWork: mocks.stop }));
vi.mock("@/lib/automation.functions", () => ({ getAutomation: mocks.load }));
import { WorkerSafetyBar } from "@/components/WorkerSafetyBar";
beforeEach(() => { vi.resetAllMocks(); mocks.load.mockResolvedValue({ role: "owner" }); });
afterEach(cleanup);
it("exposes stop only to the owner and invokes only the stop path", async () => {
  mocks.stop.mockResolvedValue({ warning: "New work blocked; external cancellation unconfirmed." });
  render(<WorkerSafetyBar />);
  fireEvent.click(await screen.findByRole("button", { name: "Kill Switch — stop work" }));
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("alert")).toHaveTextContent("external cancellation unconfirmed");
});
it("does not offer worker controls to a member", async () => {
  mocks.load.mockResolvedValue({ role: "member" });
  render(<WorkerSafetyBar />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalled());
  expect(screen.queryByRole("button")).toBeNull();
  expect(mocks.stop).not.toHaveBeenCalled();
});
it("shows stop failure without claiming success", async () => {
  mocks.stop.mockRejectedValue(new Error("Stop unavailable"));
  render(<WorkerSafetyBar />);
  fireEvent.click(await screen.findByRole("button", { name: "Kill Switch — stop work" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Stop unavailable");
});
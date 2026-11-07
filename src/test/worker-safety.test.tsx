import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, hash }: { children: React.ReactNode; hash?: string }) => (
    <a href={`/settings#${hash}`}>{children}</a>
  ),
}));
vi.mock("@/lib/automation.functions", () => ({ getAutomation: mocks.load }));
import { WorkerSafetyBar } from "@/components/WorkerSafetyBar";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({ role: "owner", policy: { paused: true } });
});
afterEach(cleanup);
it("Home shows the live Kill Switch state and links to the one control section", async () => {
  render(<WorkerSafetyBar />);
  expect(await screen.findByText("Kill Switch: on — work paused")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Kill Switch, stop & activation/ })).toHaveAttribute(
    "href",
    "/settings#activation",
  );
  expect(screen.queryByRole("button")).toBeNull();
});
it("does not show worker controls to a member", async () => {
  mocks.load.mockResolvedValue({ role: "member", policy: { paused: false } });
  render(<WorkerSafetyBar />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalled());
  expect(screen.queryByRole("link")).toBeNull();
});

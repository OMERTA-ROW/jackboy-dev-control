import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Blockers } from "@/routes/_authenticated/blockers";
const f = vi.hoisted(() => ({ load: vi.fn(), act: vi.fn(), stepUp: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => () => ({}), Link: ({ children, to, hash }: { children: React.ReactNode; to: string; hash?: string }) => <a href={`${to}${hash ? `#${hash}` : ""}`}>{children}</a> }));
vi.mock("@/components/AppShell", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/lib/blockers.functions", () => ({ getBlockers: f.load, actOnBlocker: f.act }));
vi.mock("@/lib/step-up-client", () => ({ useStepUp: () => f.stepUp }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const pid = "12345678-1234-4234-8234-123456789abc";
beforeEach(() => {
  vi.clearAllMocks();
  f.load.mockResolvedValue({ blockers: [{ id: `cap:github_repo:${pid}`, projectId: pid, projectName: "OMNI", cause: "Not approved", missing: "GitHub access", remedy: "Approve", risk: "Critical", status: "needs_approval", action: { kind: "approve", cap: "github_repo", passkey: true }, waitingTasks: [] }], repos: { [pid]: "OMERTA-ROW/Omni" }, nativeAuthorizations: {}, history: [] });
  f.stepUp.mockResolvedValue("grant");
  f.act.mockResolvedValue({ status: "connected", detail: "Real check passed", resumed: 1 });
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("GitHub blocker setup", () => {
  it("shows the direct Lovable step, exact secret name, passkey setup and approval control", async () => {
    render(<Blockers />);
    const link = await screen.findByRole("link", { name: "Open Jackboy in Lovable ↗" });
    expect(link).toHaveAttribute("href", "https://lovable.dev/projects/72823346-c174-4e90-9e17-671e197837c5");
    expect(screen.getByText(/backend Secrets as GITHUB_TOKEN/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up a passkey" })).toHaveAttribute("href", "/settings#passkeys");
    expect(screen.getByRole("button", { name: "Approve with passkey & check" })).toBeEnabled();
  });
  it("returning from GitHub does not verify or approve a still-unapproved scope", async () => {
    render(<Blockers />);
    fireEvent.click(await screen.findByRole("button", { name: /Create scoped GitHub key for OMERTA-ROW/ }));
    fireEvent.focus(window);
    await screen.findByRole("status");
    expect(f.act).not.toHaveBeenCalled(); expect(f.stepUp).not.toHaveBeenCalled();
  });
  it("explicit approval obtains a target-scoped passkey grant before the connection check", async () => {
    render(<Blockers />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve with passkey & check" }));
    await waitFor(() => expect(f.act).toHaveBeenCalledWith({ data: { cap: "github_repo", projectId: pid, op: "approve", grantId: "grant" } }));
    expect(f.stepUp).toHaveBeenCalledWith("approve_integration", `github_repo:${pid}`);
    expect(await screen.findByRole("status")).toHaveTextContent("Verified. 1 waiting task(s) resumed.");
  });
});

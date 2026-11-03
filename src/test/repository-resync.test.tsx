import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RepositoryResyncPanel } from "@/components/RepositoryResyncPanel";
const f = vi.hoisted(() => ({ scan: vi.fn(), approve: vi.fn(), stepUp: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/repository-resync.functions", () => ({ resyncRepositories: f.scan, approveRepositoryResync: f.approve }));
vi.mock("@/lib/step-up-client", () => ({ useStepUp: () => f.stepUp }));
const from = "street-Tech666/Honeycomb-terminal", to = "OMERTA-ROW/honeycomb-terminal-companion";
beforeEach(() => {
  vi.clearAllMocks();
  f.scan.mockResolvedValue({ id: "review", login: "owner", inventory: [to], checkedAt: new Date().toISOString(), rows: [{ repo: from, status: "missing", candidates: [to], references: [{ mutable: true }] }], manual: [] });
  f.stepUp.mockResolvedValue("grant");
  f.approve.mockResolvedValue({ fixed: [{ from, to }], references: 1 });
});
afterEach(cleanup);
describe("owner repository replacement authorization", () => {
  it("listing and selecting repositories never updates saved references", async () => {
    render(<RepositoryResyncPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Resync repositories" }));
    fireEvent.change(await screen.findByLabelText(`Replacement for ${from}`), { target: { value: to } });
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.stepUp).not.toHaveBeenCalled();
  });
  it("explicit owner approval sends exact replacements with scoped passkey confirmation", async () => {
    render(<RepositoryResyncPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Resync repositories" }));
    fireEvent.change(await screen.findByLabelText(`Replacement for ${from}`), { target: { value: to } });
    fireEvent.click(screen.getByRole("button", { name: "Approve selected replacements" }));
    await waitFor(() => expect(f.approve).toHaveBeenCalledWith({ data: { reviewId: "review", grantId: "grant", changes: [{ from, to }] } }));
    expect(f.stepUp).toHaveBeenCalledWith("approve_integration", "repository_resync:review");
  });
  it("failed or cancelled passkey confirmation prevents any replacement", async () => {
    f.stepUp.mockRejectedValue(new Error("Confirmation cancelled"));
    render(<RepositoryResyncPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Resync repositories" }));
    fireEvent.change(await screen.findByLabelText(`Replacement for ${from}`), { target: { value: to } });
    fireEvent.click(screen.getByRole("button", { name: "Approve selected replacements" }));
    await screen.findByRole("alert");
    expect(f.approve).not.toHaveBeenCalled();
  });
});
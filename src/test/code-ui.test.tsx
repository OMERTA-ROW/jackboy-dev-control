import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodeTasks, type useCodeTasks } from "@/components/CodeTasks";
import { LiveCallBar, type LiveCall } from "@/components/LiveVoiceCall";
import type { CodeCard } from "@/lib/code";
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
afterEach(cleanup);
const card: CodeCard = { id: "12345678-1234-4234-8234-123456789abc", projectId: "project", repo: "owner/repo", instruction: "Fix footer", status: "pending", expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: "a".repeat(48), permissions: ["Open a draft PR"], outcome: null, taskBudgetUsd: 1 };
const tasks = (c = card) => ({ cards: [c], error: null, busy: false, submit: vi.fn(), act: vi.fn(), refresh: vi.fn(), receive: vi.fn() }) as unknown as ReturnType<typeof useCodeTasks>;
describe("CODE in-chat approvals", () => {
  it("shows action, target, permissions, expiry and binds Allow to the visible request", () => {
    const t = tasks(); render(<CodeTasks tasks={t} />);
    expect(screen.getByText(/Fix footer/)).toBeInTheDocument();
    expect(screen.getByText(/Permissions: Open a draft PR/)).toBeInTheDocument();
    expect(screen.getByText(/Configured task spend reservation at request creation: up to \$1\.00/)).toBeInTheDocument();
    expect(screen.getByText(/not a cost forecast or daily-cap guarantee/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(t.act).toHaveBeenCalledWith("decide", card, "allow");
  });
  it("expired cards cannot be allowed", () => {
    render(<CodeTasks tasks={tasks({ ...card, expiresAt: new Date(0).toISOString() })} />);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
    expect(screen.getByText("Approval expired")).toBeInTheDocument();
  });
  it("does not imply a reservation when the saved amount is unavailable", () => {
    render(<CodeTasks tasks={tasks({ ...card, taskBudgetUsd: null })} />);
    expect(screen.getByText(/Configured task spend reservation at request creation: unavailable/)).toBeInTheDocument();
  });
  it("uses an accessible discreet hang-up button and keeps the audio mounted", () => {
    const end = vi.fn();
    const v = { live: true, end, call: { status: "connected", error: null, muted: false, audioRef: { current: null }, setMuted: vi.fn(), playbackBlocked: false }, mode: "listening" } as unknown as LiveCall;
    const { container } = render(<LiveCallBar v={v} />);
    fireEvent.click(screen.getByRole("button", { name: "End voice conversation" }));
    expect(end).toHaveBeenCalledOnce();
    expect(screen.queryByText("End")).not.toBeInTheDocument();
    expect(container.querySelector("audio")).toBeInTheDocument();
  });
});

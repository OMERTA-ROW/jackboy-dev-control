import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), progress: vi.fn(), stop: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/foundry.functions", () => ({ foundryInspect: mocks.inspect, foundryProgress: mocks.progress, foundryStopInspect: mocks.stop }));
import { ActivityFeed, useInspectRuns, type InspectRun } from "@/components/InspectActivity";

beforeEach(() => { vi.resetAllMocks(); mocks.progress.mockResolvedValue([]); mocks.stop.mockResolvedValue({ ok: true }); });
afterEach(cleanup);

const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const base = (over: Partial<InspectRun> = {}): InspectRun => ({
  runId: "r1", projectId: "p1", phase: "running", startedAt: Date.now() - 10_000, lastSeenAt: Date.now(),
  head: [{ id: "start", at: Date.now() - 10_000, text: "Started — opening the repository", tone: "info" }], tail: [],
  trail: [
    { project_id: "p1", action: "inspect_started", to_state: null, note: "Reading 51 files in o/app; checking 51 source file(s)…", created_at: at(8), detail: { runId: "r1" } },
    { project_id: "p1", action: "scan_progress", to_state: null, note: "Checking file 12 of 51 · src/a.ts", created_at: at(2), detail: { runId: "r1", done: 11, total: 51 } },
  ],
  ...over,
});

it("shows a live, timestamped step feed with real file progress and a Stop button", () => {
  render(<ActivityFeed run={base()} onStop={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByText("Started — opening the repository")).toBeInTheDocument();
  expect(screen.getByText("Inspecting file 12 of 51 · src/a.ts")).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")[0]!.querySelector("time")).not.toBeNull();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "22");
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("says plainly when a step stalls and offers Retry or Stop", () => {
  const onStop = vi.fn(), onRetry = vi.fn();
  render(<ActivityFeed run={base({ lastSeenAt: Date.now() - 60_000 })} onStop={onStop} onRetry={onRetry} />);
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(/No new progress for 1m 0s/);
  expect(alert).toHaveTextContent(/It may be stuck/);
  fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
  fireEvent.click(screen.getAllByRole("button", { name: "Stop" }).at(-1)!);
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onStop).toHaveBeenCalledTimes(1);
});

it("ends clearly when there was nothing to do", () => {
  render(<ActivityFeed run={base({ phase: "nothing", endedAt: Date.now(), tail: [{ id: "end", at: Date.now(), text: "Finished — nothing to do: Inspected 51 files; nothing new to fix. Run ended.", tone: "ok" }] })} onStop={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByText(/Nothing to do · finished in/)).toBeInTheDocument();
  expect(screen.getByText(/nothing new to fix. Run ended./)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
});

it("a run tags its server request, Stop targets that same run, and the result ends it", async () => {
  let resolve!: (v: unknown) => void;
  mocks.inspect.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const { result } = renderHook(() => useInspectRuns());
  act(() => { void result.current.start("k", "11111111-1111-4111-8111-111111111111"); });
  expect(result.current.runs.k?.phase).toBe("running");
  const runId = mocks.inspect.mock.calls[0]![0].data.runId as string;
  expect(runId).toBe(result.current.runs.k!.runId);
  await act(async () => { await result.current.stop("k"); });
  expect(mocks.stop).toHaveBeenCalledWith({ data: { projectId: "11111111-1111-4111-8111-111111111111", runId } });
  expect(result.current.runs.k?.phase).toBe("stopping");
  await act(async () => { resolve({ created: 0, inspectedFiles: 20, stopped: true }); });
  await waitFor(() => expect(result.current.runs.k?.phase).toBe("stopped"));
});

it("a finished run with no findings reports nothing to do", async () => {
  mocks.inspect.mockResolvedValue({ created: 0, inspectedFiles: 51 });
  const { result } = renderHook(() => useInspectRuns());
  await act(async () => { await result.current.start("k", "p1"); });
  expect(result.current.runs.k?.phase).toBe("nothing");
  expect(result.current.runs.k?.result).toBe("Inspected 51 files; nothing new to fix. Run ended.");
});

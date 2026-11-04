import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageActions } from "@/components/ChatMessageActions";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const setup = (streaming = false) => {
  const onRetry = vi.fn(), onBranch = vi.fn(), onRate = vi.fn();
  render(<ChatMessageActions text="Hello owner" assistant streaming={streaming} disabled={false} time={1793762280000} onRetry={onRetry} onBranch={onBranch} onRate={onRate} />);
  return { onRetry, onBranch, onRate };
};
describe("accessible chat message actions", () => {
  it("only invokes local retry and branch callbacks", () => {
    const handlers = setup();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Branch to CODE" }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
    expect(handlers.onBranch).toHaveBeenCalledWith("code");
  });
  it("disables actions during a partial streamed response", () => {
    const handlers = setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(handlers.onRetry).not.toHaveBeenCalled();
  });
  it("copies text for share fallback and reports clipboard failure honestly", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    setup(); fireEvent.click(screen.getByRole("button", { name: "Share message" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Message copied for sharing"));
    expect(writeText).toHaveBeenCalledWith("Hello owner");
    writeText.mockRejectedValue(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copy unavailable"));
  });
  it("reads, pauses, resumes and stops through actual device playback controls", () => {
    const synth = { speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    vi.stubGlobal("SpeechSynthesisUtterance", class { onstart?: () => void; constructor(public text: string) {} });
    setup(); fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    expect(synth.speak).toHaveBeenCalledTimes(1);
    const utterance = synth.speak.mock.calls[0]?.[0] as { onstart: () => void };
    // The playing state follows the engine's event, not the button click.
    act(() => utterance.onstart());
    fireEvent.click(screen.getByRole("button", { name: "Pause reading aloud" }));
    expect(synth.pause).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Resume reading aloud" }));
    expect(synth.resume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop reading aloud" }));
    expect(screen.getByRole("button", { name: "Read aloud" })).toBeInTheDocument();
  });
});
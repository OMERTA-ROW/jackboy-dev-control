/** Pure helpers for chat scroll anchoring, speak-back and reply feedback (kept DOM-free so they are testable). */

export const NEAR_BOTTOM_PX = 120;

export type ScrollMetrics = { scrollTop: number; viewportHeight: number; scrollHeight: number };

/** True when the reader is within `threshold` px of the end of the conversation. */
export function isNearBottom(m: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return m.scrollHeight - (m.scrollTop + m.viewportHeight) <= threshold;
}

/**
 * Follow state machine: a deliberate upward scroll releases follow; returning near the
 * bottom re-engages it. Content growth alone (streamed tokens) never changes the state.
 */
export function nextFollow(prev: { follow: boolean; lastTop: number }, m: ScrollMetrics): { follow: boolean; lastTop: number } {
  const movedUp = m.scrollTop < prev.lastTop - 4;
  if (isNearBottom(m)) return { follow: true, lastTop: m.scrollTop };
  if (movedUp) return { follow: false, lastTop: m.scrollTop };
  return { follow: prev.follow, lastTop: m.scrollTop };
}

/** Target scrollTop that pins the bottom, or null when we must preserve the reading position. */
export function followTarget(follow: boolean, m: ScrollMetrics): number | null {
  if (!follow) return null;
  const target = Math.max(0, m.scrollHeight - m.viewportHeight);
  return Math.abs(target - m.scrollTop) < 1 ? null : target;
}

/** Strips markdown so speech engines read words, not symbols. */
export function speakableText(md: string, max = 4000): string {
  return md
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/[#*_>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export type Feedback = "up" | "down";
export const feedbackKey = (userId: string) => `jackboy:feedback:${userId}`;

/** Toggle semantics: choosing the same rating again clears it. */
export function toggleFeedback(map: Record<string, Feedback>, id: string, value: Feedback): Record<string, Feedback> {
  const next = { ...map };
  if (next[id] === value) delete next[id]; else next[id] = value;
  return next;
}

export function parseFeedback(raw: string | null): Record<string, Feedback> {
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x === "up" || x === "down")) as Record<string, Feedback>;
  } catch { return {}; }
}

/** Composer grows with its content up to ~40% of the visible viewport (keyboard-aware), clamped 120–320px. */
export function composerHeight(contentHeight: number, viewportHeight: number): { height: number; overflow: boolean } {
  const max = Math.round(Math.min(320, Math.max(120, viewportHeight * 0.4)));
  return { height: Math.min(contentHeight, max), overflow: contentHeight > max };
}

/** When older history is inserted above, keep the same message under the reader's eyes. */
export function preservedScrollTop(prevTop: number, prevHeight: number, nextHeight: number): number {
  return Math.max(0, prevTop + (nextHeight - prevHeight));
}

/** Coalesces many calls in one frame into a single callback (streamed tokens, resize bursts). */
export function frameBatcher(fn: () => void, raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb), caf: (id: number) => void = (id) => cancelAnimationFrame(id)) {
  let id: number | null = null;
  return {
    schedule() { if (id === null) id = raf(() => { id = null; fn(); }); },
    cancel() { if (id !== null) { caf(id); id = null; } },
  };
}

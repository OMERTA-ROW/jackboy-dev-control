// Saved conversations (pure, tested): searchable text, change detection and search helpers.
import { redact } from "./chat-history";

export const MAX_CONTENT = 40000;
export const SAVE_BATCH = 60;

type PartLike = { type?: string; text?: string; filename?: string };
/** Searchable text: message words plus attachment names, with credential-looking strings hidden. */
export function messageContent(parts: unknown[]): string {
  const out: string[] = [];
  for (const p of parts as PartLike[]) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") out.push(p.text);
    else if (p.type === "file" && typeof p.filename === "string") out.push(`[${p.filename}]`);
  }
  return redact(out.join("\n")).slice(0, MAX_CONTENT);
}

export const fingerprint = (m: { parts: unknown[]; metadata?: unknown }) => JSON.stringify([m.parts, m.metadata ?? null]);

/** Messages that are new or changed since the last successful save. */
export function changedMessages<T extends { id: string; parts: unknown[]; metadata?: unknown }>(messages: T[], saved: Map<string, string>): T[] {
  return messages.filter((m) => saved.get(m.id) !== fingerprint(m));
}

export function cleanQuery(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const t = q.replace(/\s+/g, " ").trim().slice(0, 100);
  return t.length >= 2 ? t : null;
}
/** Escape LIKE wildcards so the owner's text is matched literally. */
export const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export function searchSnippet(content: string, q: string, radius = 60): string {
  const i = content.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return content.slice(0, radius * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, i - radius), end = Math.min(content.length, i + q.length + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).replace(/\s+/g, " ").trim()}${end < content.length ? "…" : ""}`;
}

/** Message time for ordering: the recorded arrival time, else a stable offset after a base time. */
export function messageCreatedAt(meta: unknown, fallbackMs: number): string {
  const t = (meta as { createdAt?: unknown } | null)?.createdAt;
  const ms = typeof t === "number" && Number.isFinite(t) && t > 1e12 && t < 1e14 ? t : fallbackMs;
  return new Date(ms).toISOString();
}

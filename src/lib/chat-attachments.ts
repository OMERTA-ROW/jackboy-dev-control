// Chat attachments (pure, tested). Files live in the private "chat-attachments" bucket inside the
// owner's own folder; messages refer to them as jbstore:<path>, never as public links.

export const ATTACH_BUCKET = "chat-attachments";
export const STORE_PREFIX = "jbstore:";
export const MAX_PER_MESSAGE = 6;
export const MAX_FRAMES = 6;
export const LIMITS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024, text: 200 * 1024 } as const;
export type AttachKind = keyof typeof LIMITS;

const TYPES: Record<string, AttachKind> = {
  "image/png": "image", "image/jpeg": "image", "image/webp": "image", "image/gif": "image",
  "video/mp4": "video", "video/webm": "video", "video/quicktime": "video",
  "text/plain": "text", "text/markdown": "text", "text/csv": "text", "application/json": "text",
};
export const ACCEPT = Object.keys(TYPES).join(",") + ",.md,.txt,.csv,.json";

export function attachmentKind(mime: string, name = ""): AttachKind | null {
  const t = TYPES[mime.toLowerCase()];
  if (t) return t;
  // Some browsers leave text types empty; only these plain-text extensions are accepted then.
  if (!mime && /\.(md|txt|csv|json)$/i.test(name)) return "text";
  return null;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
export function validateAttachment(f: { name: string; type: string; size: number }): { ok: true; kind: AttachKind } | { ok: false; reason: string } {
  const kind = attachmentKind(f.type, f.name);
  if (!kind) return { ok: false, reason: `${f.name}: only images (PNG, JPEG, WebP, GIF), short videos (MP4, WebM, MOV) or text files can be attached.` };
  if (!(f.size > 0)) return { ok: false, reason: `${f.name} is empty.` };
  if (f.size > LIMITS[kind]) return { ok: false, reason: `${f.name} is too large (limit ${kind === "text" ? "200 KB" : mb(LIMITS[kind])}).` };
  return { ok: true, kind };
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = base.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(-80);
  return clean || "file";
}
export const attachmentPath = (userId: string, threadId: string, id: string, name: string) => `${userId}/${threadId}/${id}-${safeFileName(name)}`;

/** A path is usable only inside the signed-in owner's own folder, with no traversal. */
export function ownedPath(path: unknown, userId: string): path is string {
  if (typeof path !== "string" || !userId || path.length > 400) return false;
  if (!path.startsWith(`${userId}/`) || path.includes("..") || path.includes("//")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(path);
}
export const storeUrl = (path: string) => `${STORE_PREFIX}${path}`;
export const pathFromStoreUrl = (url: unknown) => (typeof url === "string" && url.startsWith(STORE_PREFIX) ? url.slice(STORE_PREFIX.length) : null);

/** Evenly spaced frame times, never the very last instant (often black). */
export function frameTimes(duration: number, n = MAX_FRAMES): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(n), Math.ceil(duration * 2)));
  return Array.from({ length: count }, (_, i) => Math.round(((duration * (i + 0.5)) / count) * 10) / 10);
}
export const frameName = (video: string, t: number) => `${video} @ ${t.toFixed(1)}s`;
export function parseFrameName(filename: unknown): { video: string; t: number } | null {
  if (typeof filename !== "string") return null;
  const m = /^(.*) @ (\d+(?:\.\d)?)s$/.exec(filename);
  return m ? { video: m[1]!, t: Number(m[2]) } : null;
}

type FilePartLike = { filename?: string | undefined; mediaType?: string | undefined };
/** Text placed before each attachment so the model knows exactly what it is looking at. */
export function attachmentNote(p: FilePartLike): string {
  const name = p.filename ?? "attachment";
  const frame = parseFrameName(name);
  if (frame) return `[Still frame at ${frame.t.toFixed(1)}s from video "${frame.video}". Motion between frames was not seen.]`;
  const kind = attachmentKind(p.mediaType ?? "", name);
  if (kind === "video") return `[Video "${name}" attached; you receive its sampled still frames, not the video itself.]`;
  if (kind === "text") return `[Text file "${name}":]`;
  return `[Image "${name}":]`;
}

/** Only attachments in the most recent user turns are re-sent to the model; older ones become a note. */
export function inlineTurns<T extends { role: string }>(messages: T[], recent = 2): Set<number> {
  const keep = new Set<number>();
  for (let i = messages.length - 1; i >= 0 && keep.size < recent; i--) if (messages[i]!.role === "user") keep.add(i);
  return keep;
}

// Private chat attachments: upload to the owner's own folder, sample video frames in the browser,
// and show stored attachments through short-lived signed links (never public URLs).
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Film, Loader2, Paperclip, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ACCEPT, ATTACH_BUCKET, MAX_PER_MESSAGE, attachmentPath, frameName, frameTimes, parseFrameName, pathFromStoreUrl, storeUrl, validateAttachment, type AttachKind } from "@/lib/chat-attachments";

export type StoredFilePart = { type: "file"; url: string; mediaType: string; filename: string };
type Pending = { id: string; name: string; kind: AttachKind; status: "uploading" | "ready" | "error"; detail: string; preview: string | null; parts: StoredFilePart[]; paths: string[] };

async function upload(path: string, body: Blob, contentType: string) {
  const { error } = await supabase.storage.from(ATTACH_BUCKET).upload(path, body, { contentType, upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
}

function waitFor(el: HTMLVideoElement, event: string, ms: number, failText: string) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(failText)); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error("This browser can't read that video.")); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(event, ok); el.removeEventListener("error", bad); };
    el.addEventListener(event, ok, { once: true }); el.addEventListener("error", bad, { once: true });
  });
}

/** Still frames at evenly spaced times. The model only ever sees these stills, never motion. */
async function sampleFrames(file: File): Promise<{ duration: number; frames: { t: number; blob: Blob }[] }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  try {
    await waitFor(v, "loadeddata", 15000, "Timed out reading the video.");
    const times = frameTimes(v.duration);
    const scale = Math.min(1, 1024 / Math.max(v.videoWidth || 1, v.videoHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((v.videoWidth || 640) * scale));
    canvas.height = Math.max(1, Math.round((v.videoHeight || 360) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't draw video frames.");
    const frames: { t: number; blob: Blob }[] = [];
    for (const t of times) {
      if (Math.abs(v.currentTime - t) > 0.01) { const seek = waitFor(v, "seeked", 8000, `Couldn't reach ${t.toFixed(1)}s in the video.`); v.currentTime = t; await seek; }
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
      if (blob) frames.push({ t, blob });
    }
    if (!frames.length) throw new Error("No frames could be read from the video.");
    return { duration: v.duration, frames };
  } finally { URL.revokeObjectURL(url); v.removeAttribute("src"); v.load(); }
}

export function usePendingAttachments(userId: string | null, threadId: string) {
  const [items, setItems] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, patch: Partial<Pending>) => setItems((cur) => cur.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const add = useCallback(async (files: FileList | File[]) => {
    setError(null);
    if (!userId) { setError("Sign in again to attach files."); return; }
    const list = Array.from(files);
    if (items.length + list.length > MAX_PER_MESSAGE) { setError(`Up to ${MAX_PER_MESSAGE} attachments per message.`); return; }
    for (const file of list) {
      const check = validateAttachment(file);
      if (!check.ok) { setError(check.reason); continue; }
      const id = crypto.randomUUID();
      const type = file.type || "text/plain";
      const preview = check.kind === "image" || check.kind === "video" ? URL.createObjectURL(file) : null;
      setItems((cur) => [...cur, { id, name: file.name, kind: check.kind, status: "uploading", detail: "Uploading…", preview, parts: [], paths: [] }]);
      try {
        const path = attachmentPath(userId, threadId, id, file.name);
        await upload(path, file, type);
        const parts: StoredFilePart[] = [{ type: "file", url: storeUrl(path), mediaType: type, filename: file.name }];
        const paths = [path];
        if (check.kind === "video") {
          update(id, { detail: "Sampling frames…" });
          const { frames } = await sampleFrames(file);
          for (const f of frames) {
            const name = frameName(file.name, f.t);
            const fp = attachmentPath(userId, threadId, `${id}-f${Math.round(f.t * 10)}`, `${file.name}.jpg`);
            await upload(fp, f.blob, "image/jpeg");
            parts.push({ type: "file", url: storeUrl(fp), mediaType: "image/jpeg", filename: name });
            paths.push(fp);
          }
          update(id, { status: "ready", detail: `${frames.length} frames sampled`, parts, paths });
        } else update(id, { status: "ready", detail: "Ready", parts, paths });
      } catch (e) {
        update(id, { status: "error", detail: e instanceof Error ? e.message : "Upload failed." });
      }
    }
  }, [userId, threadId, items.length]);

  const remove = useCallback((id: string) => {
    setItems((cur) => {
      const it = cur.find((x) => x.id === id);
      if (it?.paths.length) void supabase.storage.from(ATTACH_BUCKET).remove(it.paths);
      if (it?.preview) URL.revokeObjectURL(it.preview);
      return cur.filter((x) => x.id !== id);
    });
  }, []);
  const clear = useCallback(() => setItems((cur) => { cur.forEach((x) => x.preview && URL.revokeObjectURL(x.preview)); return []; }), []);
  const ready = items.filter((x) => x.status === "ready");
  return { items, error, setError, add, remove, clear, busy: items.some((x) => x.status === "uploading"), parts: ready.flatMap((x) => x.parts), hasReady: ready.length > 0 };
}
export type PendingAttachments = ReturnType<typeof usePendingAttachments>;

export function AttachButton({ a, disabled }: { a: PendingAttachments; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden
        onChange={(e) => { if (e.target.files?.length) void a.add(e.target.files); e.target.value = ""; }} />
      <button type="button" disabled={disabled} onClick={() => input.current?.click()} aria-label="Attach image, video or text file" title="Attach (private to you)"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-electric disabled:opacity-40"><Paperclip className="size-4" /></button>
    </>
  );
}

export function PendingChips({ a }: { a: PendingAttachments }) {
  if (!a.items.length && !a.error) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2 px-1">
      {a.items.map((x) => (
        <div key={x.id} className={`flex max-w-[16rem] items-center gap-2 rounded-xl border px-2 py-1 text-xs ${x.status === "error" ? "border-destructive text-destructive" : "border-border"}`}>
          {x.kind === "image" && x.preview ? <img src={x.preview} alt="" className="size-8 rounded object-cover" /> : x.kind === "video" ? <Film className="size-4" aria-hidden /> : <FileText className="size-4" aria-hidden />}
          <span className="min-w-0"><span className="block truncate">{x.name}</span><span className="block truncate text-muted-foreground">{x.status === "uploading" ? <Loader2 className="mr-1 inline size-3 animate-spin" aria-hidden /> : null}{x.detail}</span></span>
          <button type="button" onClick={() => a.remove(x.id)} aria-label={`Remove ${x.name}`} className="text-muted-foreground hover:text-destructive"><X className="size-3.5" /></button>
        </div>
      ))}
      {a.error && <p role="alert" className="w-full text-xs text-destructive">{a.error}</p>}
    </div>
  );
}

function useSignedUrl(url: string) {
  const [signed, setSigned] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const path = pathFromStoreUrl(url);
    if (!path) { setFailed(true); return; }
    let alive = true;
    void supabase.storage.from(ATTACH_BUCKET).createSignedUrl(path, 3600).then(({ data, error }) => { if (!alive) return; if (error || !data) setFailed(true); else setSigned(data.signedUrl); });
    return () => { alive = false; };
  }, [url]);
  return { signed, failed };
}

function StoredImage({ p, small }: { p: StoredFilePart; small?: boolean }) {
  const { signed, failed } = useSignedUrl(p.url);
  if (failed) return <span className="text-xs text-muted-foreground">{p.filename} (unavailable)</span>;
  if (!signed) return <span className={`inline-block animate-pulse rounded-lg bg-muted ${small ? "size-16" : "h-32 w-40"}`} aria-label="Loading image" />;
  return <a href={signed} target="_blank" rel="noopener noreferrer" title={p.filename}><img src={signed} alt={p.filename} className={`rounded-lg border border-border object-cover ${small ? "size-16" : "max-h-56 max-w-full"}`} /></a>;
}
function StoredVideo({ p }: { p: StoredFilePart }) {
  const { signed, failed } = useSignedUrl(p.url);
  if (failed) return <span className="text-xs text-muted-foreground">{p.filename} (unavailable)</span>;
  if (!signed) return <span className="inline-block h-32 w-48 animate-pulse rounded-lg bg-muted" aria-label="Loading video" />;
  return <video src={signed} controls preload="metadata" className="max-h-56 max-w-full rounded-lg border border-border" />;
}
function StoredFile({ p }: { p: StoredFilePart }) {
  const { signed, failed } = useSignedUrl(p.url);
  return <span className="inline-flex items-center gap-1 text-xs"><FileText className="size-3.5" aria-hidden />{signed && !failed ? <a href={signed} target="_blank" rel="noopener noreferrer" className="underline">{p.filename}</a> : <span>{p.filename}{failed ? " (unavailable)" : ""}</span>}</span>;
}

/** Attachments inside a saved message. Sampled frames sit in a fold under their video. */
export function MessageAttachments({ parts }: { parts: unknown[] }) {
  const files = (parts as StoredFilePart[]).filter((p) => p?.type === "file" && typeof p.url === "string" && pathFromStoreUrl(p.url));
  if (!files.length) return null;
  const frames = files.filter((f) => parseFrameName(f.filename));
  const main = files.filter((f) => !parseFrameName(f.filename));
  return (
    <div className="mt-2 flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {main.map((f) => f.mediaType.startsWith("image/") ? <StoredImage key={f.url} p={f} /> : f.mediaType.startsWith("video/") ? <StoredVideo key={f.url} p={f} /> : <StoredFile key={f.url} p={f} />)}
      </div>
      {frames.length > 0 && <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{frames.length} still frames Jackboy looked at</summary>
        <div className="mt-2 flex flex-wrap justify-end gap-1">{frames.map((f) => <figure key={f.url} className="text-center"><StoredImage p={f} small /><figcaption>{parseFrameName(f.filename)!.t.toFixed(1)}s</figcaption></figure>)}</div>
      </details>}
    </div>
  );
}

// Turns jbstore: attachment references into model input, using the owner's own storage access.
// Only the owner's folder is read; only the latest user turns are re-sent; videos go as frames.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UIMessage } from "ai";
import { ATTACH_BUCKET, attachmentKind, attachmentNote, inlineTurns, LIMITS, ownedPath, pathFromStoreUrl } from "./chat-attachments";

const TOTAL_INLINE = 20 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type FilePart = { type: "file"; url: string; mediaType: string; filename?: string };
type Part = UIMessage["parts"][number];

export async function prepareAttachments(messages: UIMessage[], userId: string, sb: SupabaseClient): Promise<{ messages: UIMessage[]; visual: boolean }> {
  const recent = inlineTurns(messages);
  let budget = TOTAL_INLINE;
  let visual = false;
  const out: UIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "user" || !m.parts.some((p) => p.type === "file")) { out.push(m); continue; }
    const parts: Part[] = [];
    for (const p of m.parts) {
      if (p.type !== "file") { parts.push(p); continue; }
      const f = p as FilePart;
      const path = pathFromStoreUrl(f.url);
      const kind = attachmentKind(f.mediaType ?? "", f.filename ?? "");
      if (!path || !ownedPath(path, userId) || !kind) { parts.push({ type: "text", text: `[Attachment "${f.filename ?? "file"}" skipped: not in your private storage.]` }); continue; }
      if (!recent.has(i)) { parts.push({ type: "text", text: `[Earlier attachment "${f.filename ?? "file"}" — not re-sent.]` }); continue; }
      parts.push({ type: "text", text: attachmentNote(f) });
      if (kind === "video") { visual = true; continue; } // its sampled frames follow as images
      const dl = await sb.storage.from(ATTACH_BUCKET).download(path);
      if (dl.error || !dl.data) { parts.push({ type: "text", text: `[Couldn't read "${f.filename ?? "file"}" from storage.]` }); continue; }
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      if (bytes.length > LIMITS[kind] || bytes.length > budget) { parts.push({ type: "text", text: `[“${f.filename ?? "file"}” too large to send this turn.]` }); continue; }
      budget -= bytes.length;
      if (kind === "text") parts.push({ type: "text", text: new TextDecoder().decode(bytes).slice(0, LIMITS.text) });
      else { visual = true; parts.push({ type: "file", mediaType: f.mediaType, filename: f.filename, url: `data:${f.mediaType};base64,${toBase64(bytes)}` } as Part); }
    }
    out.push({ ...m, parts });
  }
  return { messages: out, visual };
}

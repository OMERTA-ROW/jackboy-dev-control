// Owner chat storage: conversations, search, agent contexts and a short status digest.
// Every read/write uses the caller's own client (RLS: owner + own rows); nothing here starts work.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { untyped } from "./untyped-db";
import { cleanQuery, escapeLike, messageContent, messageCreatedAt, searchSnippet, SAVE_BATCH } from "./chat-threads";
import { ATTACH_BUCKET, ownedPath, pathFromStoreUrl } from "./chat-attachments";
import { JACKBOY_KEY, parseContextKey, slugFor } from "./chat-context";

type Ctx = { userId: string; supabase: SupabaseClient };
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
async function owner(ctx: unknown) {
  const c = ctx as Ctx;
  const { data: role } = await c.supabase.rpc("my_role" as never);
  if (role !== "owner") throw new Error("Jackboy Chat is owner-only.");
  return { userId: c.userId, db: untyped(c.supabase), sb: c.supabase };
}

const uuid = z.string().uuid();
const contextKey = z.string().max(80).refine((k) => parseContextKey(k) !== null, "Unknown context");
const messageInput = z.object({
  uiId: z.string().min(1).max(200),
  role: z.enum(["user", "assistant", "system"]),
  author: z.string().max(80).default(""),
  contextKey: z.string().max(80).nullable().default(null),
  parts: z.array(z.unknown()).max(200),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const saveInput = z.object({
  id: uuid, mode: z.enum(["chat", "code"]), title: z.string().min(1).max(120), contextKey,
  messages: z.array(messageInput).max(SAVE_BATCH),
}).strict();

/** File parts must point into the owner's own folder; anything else is dropped before saving. */
function cleanParts(parts: unknown[], userId: string): unknown[] {
  return parts.filter((p) => {
    const part = p as { type?: string; url?: string };
    if (part?.type !== "file") return true;
    return ownedPath(pathFromStoreUrl(part.url), userId);
  });
}

export const listChatThreads = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { db } = await owner(context);
  const { data, error } = await db.from("chat_threads").select("id, title, mode, context_key, updated_at").order("updated_at", { ascending: false }).limit(150);
  if (error) throw new Error(`Couldn't load conversations: ${error.message}`);
  return (data ?? []) as { id: string; title: string; mode: "chat" | "code"; context_key: string; updated_at: string }[];
});

export const getChatThread = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ context, data }) => {
    const { db } = await owner(context);
    const t = await db.from("chat_threads").select("id, title, mode, context_key, updated_at").eq("id", data.id).maybeSingle();
    if (t.error) throw new Error(`Couldn't open this conversation: ${t.error.message}`);
    if (!t.data) return { thread: null, messages: [] };
    const m = await db.from("chat_messages").select("ui_id, role, parts, metadata, author, context_key, created_at").eq("thread_id", data.id).order("created_at", { ascending: true }).limit(1000);
    if (m.error) throw new Error(`Couldn't load messages: ${m.error.message}`);
    return {
      thread: t.data as { id: string; title: string; mode: "chat" | "code"; context_key: string; updated_at: string },
      messages: ((m.data ?? []) as { ui_id: string; role: "user" | "assistant" | "system"; parts: unknown[]; metadata: Record<string, unknown>; author: string; context_key: string | null }[])
        .map((r) => ({ id: r.ui_id, role: r.role, parts: r.parts as Json[], metadata: { ...(r.metadata as Record<string, Json>), ...(r.author ? { author: r.author } : {}), ...(r.context_key ? { contextKey: r.context_key } : {}) } })),
    };
  });

export const saveChatThread = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveInput.parse(d))
  .handler(async ({ context, data }) => {
    const { db, userId } = await owner(context);
    const now = Date.now();
    const t = await db.from("chat_threads").upsert({ id: data.id, owner_id: userId, mode: data.mode, title: data.title, context_key: data.contextKey, updated_at: new Date(now).toISOString() }, { onConflict: "id" });
    if (t.error) throw new Error(`Conversation not saved: ${t.error.message}`);
    if (!data.messages.length) return { saved: 0 };
    const rows = data.messages.map((m, i) => {
      const parts = cleanParts(m.parts, userId);
      return {
        thread_id: data.id, owner_id: userId, ui_id: m.uiId, role: m.role, author: m.author, context_key: m.contextKey,
        parts, metadata: m.metadata, content: messageContent(parts), created_at: messageCreatedAt(m.metadata, now - (data.messages.length - i)),
      };
    });
    const r = await db.from("chat_messages").upsert(rows, { onConflict: "thread_id,ui_id" });
    if (r.error) throw new Error(`Messages not saved: ${r.error.message}`);
    return { saved: rows.length };
  });

export const deleteChatThread = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).strict().parse(d))
  .handler(async ({ context, data }) => {
    const { db, sb, userId } = await owner(context);
    const { error } = await db.from("chat_threads").delete().eq("id", data.id);
    if (error) throw new Error(`Couldn't delete: ${error.message}`);
    // Remove this conversation's private attachments too; failures are reported, not hidden.
    const folder = `${userId}/${data.id}`;
    const list = await sb.storage.from(ATTACH_BUCKET).list(folder, { limit: 200 });
    const names = (list.data ?? []).map((f) => `${folder}/${f.name}`);
    const removed = names.length ? await sb.storage.from(ATTACH_BUCKET).remove(names) : { error: null };
    return { deleted: true, attachmentsLeft: removed.error ? names.length : 0 };
  });

export const searchChatHistory = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ q: z.string().max(200) }).strict().parse(d))
  .handler(async ({ context, data }) => {
    const { db } = await owner(context);
    const q = cleanQuery(data.q);
    if (!q) return [];
    const pattern = `%${escapeLike(q)}%`;
    const [msgs, titles] = await Promise.all([
      db.from("chat_messages").select("thread_id, ui_id, role, content, created_at, chat_threads(title, mode)").ilike("content", pattern).order("created_at", { ascending: false }).limit(40),
      db.from("chat_threads").select("id, title, mode, updated_at").ilike("title", pattern).order("updated_at", { ascending: false }).limit(10),
    ]);
    if (msgs.error) throw new Error(`Search failed: ${msgs.error.message}`);
    type Row = { thread_id: string; ui_id: string; role: string; content: string; created_at: string; chat_threads: { title: string; mode: string } | null };
    const hits = ((msgs.data ?? []) as unknown as Row[]).map((r) => ({ threadId: r.thread_id, messageId: r.ui_id, title: r.chat_threads?.title ?? "Conversation", mode: r.chat_threads?.mode ?? "chat", role: r.role, snippet: searchSnippet(r.content, q), at: r.created_at }));
    for (const t of (titles.data ?? []) as { id: string; title: string; mode: string; updated_at: string }[]) {
      if (!hits.some((h) => h.threadId === t.id)) hits.push({ threadId: t.id, messageId: "", title: t.title, mode: t.mode, role: "title", snippet: t.title, at: t.updated_at });
    }
    return hits;
  });

// ---- Agent / project contexts ----

export const listChatContexts = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { db } = await owner(context);
  const [agents, projects] = await Promise.all([
    db.from("chat_contexts").select("id, slug, name, role, kind, project_id, notes, notes_updated_at").order("created_at", { ascending: true }),
    db.from("owner_projects").select("id, name, github_repo, description, goals, notes").eq("active", true).order("name"),
  ]);
  if (agents.error) throw new Error(`Couldn't load agents: ${agents.error.message}`);
  return {
    jackboy: JACKBOY_KEY,
    agents: ((agents.data ?? []) as { id: string; slug: string; name: string; role: string; kind: string; project_id: string | null; notes: string; notes_updated_at: string | null }[])
      .map((a) => ({ id: a.id, slug: a.slug, name: a.name, role: a.role, kind: a.kind as "agent" | "visual_observer", projectId: a.project_id, hasNotes: a.notes.trim().length > 0, notesUpdatedAt: a.notes_updated_at })),
    projects: ((projects.data ?? []) as { id: string; name: string; github_repo: string | null; description: string | null; goals: string | null; notes: string | null }[])
      .map((p) => ({ id: p.id, name: p.name, hasRepo: Boolean(p.github_repo), hasNotes: Boolean(`${p.description ?? ""}${p.goals ?? ""}${p.notes ?? ""}`.trim()) })),
  };
});

export const getChatContextBrief = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ key: contextKey }).strict().parse(d))
  .handler(async ({ context, data }) => {
    const { sb } = await owner(context);
    const { loadContextBrief } = await import("./chat-context.server");
    const brief = await loadContextBrief(sb, data.key);
    if (!brief) throw new Error("That agent or project no longer exists.");
    let ownerNotes = "";
    const ref = parseContextKey(data.key);
    if (ref?.type === "agent") {
      const { data: row } = await untyped(sb).from("chat_contexts").select("notes").eq("id", ref.id).maybeSingle();
      ownerNotes = (row as { notes: string } | null)?.notes ?? "";
    }
    return { brief, ownerNotes };
  });

const contextInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(200).default(""),
  kind: z.enum(["agent", "visual_observer"]).default("agent"),
  projectId: uuid.nullable().default(null),
  notes: z.string().max(8000),
}).strict();

export const saveChatContext = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => contextInput.parse(d))
  .handler(async ({ context, data }) => {
    const { db, userId } = await owner(context);
    const now = new Date().toISOString();
    let id = data.id;
    let notesChanged = true;
    if (id) {
      const prev = await db.from("chat_contexts").select("notes").eq("id", id).maybeSingle();
      if (prev.error || !prev.data) throw new Error("Agent not found.");
      notesChanged = (prev.data as { notes: string }).notes !== data.notes;
      const { error } = await db.from("chat_contexts").update({
        name: data.name, role: data.role, kind: data.kind, project_id: data.projectId, notes: data.notes, updated_at: now,
        ...(notesChanged ? { notes_updated_at: now, notes_updated_by: userId } : {}),
      }).eq("id", id);
      if (error) throw new Error(`Not saved: ${error.message}`);
    } else {
      const ins = await db.from("chat_contexts").insert({ slug: `${slugFor(data.name)}-${crypto.randomUUID().slice(0, 6)}`, name: data.name, role: data.role, kind: data.kind, project_id: data.projectId, notes: data.notes, notes_updated_at: data.notes ? now : null, notes_updated_by: data.notes ? userId : null }).select("id").single();
      if (ins.error) throw new Error(`Not saved: ${ins.error.message}`);
      id = (ins.data as { id: string }).id;
    }
    // Audit: who changed which agent's notes, never the note text itself.
    const { logSite } = await import("./site-log.server");
    await logSite({ actor: `owner:${userId}`, action: data.id ? "chat.context_updated" : "chat.context_added", category: "config", status: "ok", project_id: data.projectId, summary: `${data.id ? "Updated" : "Added"} chat agent "${data.name}"${notesChanged ? " (notes changed)" : ""}.` });
    return { id };
  });

// ---- Status digest (read-only) ----

export const getChatDigest = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { db } = await owner(context);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const safe = async <T,>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };
  const [safety, waiting, failures, unread] = await Promise.all([
    safe(async () => { const s = await (await import("./code-safety.server")).getCodeSafetyState(); return { killSwitch: s.killSwitch, codeEnabled: s.enabled }; }),
    safe(async () => { const w = await (await import("./owner-alerts.server")).waitingItems(); return { complete: w.complete, items: w.drafts.slice(0, 5).map((d) => ({ title: d.title, link: d.link })), count: w.drafts.length }; }),
    safe(async () => {
      const r = await db.from("site_log").select("action, summary, at, pr_url", { count: "exact" }).eq("status", "failed").gte("at", since).order("at", { ascending: false }).limit(3);
      if (r.error) throw r.error;
      return { count: r.count ?? 0, latest: (r.data ?? []) as { action: string; summary: string; at: string; pr_url: string | null }[] };
    }),
    safe(async () => { const r = await db.from("owner_notifications").select("id", { count: "exact", head: true }).eq("read", false); if (r.error) throw r.error; return r.count ?? 0; }),
  ]);
  return { at: new Date().toISOString(), safety, waiting, failures, unread };
});

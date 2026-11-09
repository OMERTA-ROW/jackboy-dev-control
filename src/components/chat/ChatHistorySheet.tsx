// Saved conversations for the account, search across all of them, and a one-press import of
// conversations that were saved only in this browser.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Pencil, Search, Trash2, Upload } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { searchChatHistory } from "@/lib/chat-threads.functions";
import { cleanQuery } from "@/lib/chat-threads";

export type ThreadRow = { id: string; title: string; mode: "chat" | "code"; context_key: string; updated_at: string };
type Hit = Awaited<ReturnType<typeof searchChatHistory>>[number];

export function ChatHistorySheet({ open, onOpenChange, mode, threads, loadError, activeId, onOpen, onDelete, onRename, localCount, onImport, importing }: {
  open: boolean; onOpenChange: (o: boolean) => void; mode: "chat" | "code"; threads: ThreadRow[] | null; loadError: string | null; activeId: string;
  onOpen: (id: string) => void; onDelete: (id: string) => void; localCount: number; onImport: () => void; importing: string | null;
  onRename: (id: string, title: string) => Promise<boolean>;
}) {
  const search = useServerFn(searchChatHistory);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const query = cleanQuery(q);
    if (!query) { setHits(null); setErr(null); return; }
    let alive = true;
    const t = setTimeout(() => { search({ data: { q: query } }).then((h) => { if (alive) { setHits(h); setErr(null); } }).catch((e) => alive && setErr((e as Error).message)); }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q, search]);
  const list = (threads ?? []).filter((t) => t.mode === mode);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-80 max-w-[85vw] flex-col">
        <SheetHeader><SheetTitle>{mode === "code" ? "CODE conversations" : "Conversations"}</SheetTitle><SheetDescription>Saved privately to your account. Only you can see them.</SheetDescription></SheetHeader>
        <label className="relative mt-3 block">
          <span className="sr-only">Search all conversations</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all conversations" className="w-full rounded-full border border-border bg-card py-2 pl-9 pr-3 text-sm outline-none focus:border-silver" />
        </label>
        {localCount > 0 && <button type="button" disabled={Boolean(importing)} onClick={onImport} className="mt-3 inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-left text-xs hover:border-silver disabled:opacity-60">
          <Upload className="size-4 shrink-0" aria-hidden />{importing ?? `Import ${localCount} conversation${localCount === 1 ? "" : "s"} saved only on this device`}
        </button>}
        <ul className="mt-3 flex-1 space-y-1 overflow-y-auto">
          {err && <li role="alert" className="px-2 text-sm text-destructive">{err}</li>}
          {hits ? (hits.length === 0 ? <li className="px-2 text-sm text-muted-foreground">No matches.</li> : hits.map((h, i) => (
            <li key={`${h.threadId}-${h.messageId}-${i}`}>
              <button type="button" onClick={() => onOpen(h.threadId)} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted">
                <span className="block truncate font-medium">{h.title}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{h.role === "user" ? "You: " : h.role === "assistant" ? "Jackboy: " : ""}{h.snippet}</span>
                <span className="block text-[11px] text-muted-foreground">{h.mode === "code" ? "CODE · " : ""}{new Date(h.at).toLocaleString()}</span>
              </button>
            </li>
          ))) : loadError ? <li role="alert" className="px-2 text-sm text-destructive">{loadError}</li>
            : !threads ? <li className="px-2 text-sm text-muted-foreground">Loading…</li>
            : list.length === 0 ? <li className="px-2 text-sm text-muted-foreground">No saved conversations yet.</li>
            : list.map((c) => (
              <li key={c.id} className={`flex items-center gap-1 rounded-lg ${c.id === activeId ? "bg-muted" : ""}`}>
                {editing === c.id ? <form className="flex min-w-0 flex-1 gap-1" onSubmit={async (e) => {
                  e.preventDefault();
                  if (saving || !title.trim()) return;
                  setSaving(true);
                  try { if (await onRename(c.id, title.trim())) setEditing(null); }
                  finally { setSaving(false); }
                }}>
                  <input aria-label="Conversation title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-card px-2" />
                  <button type="submit" disabled={saving || !title.trim()} className="px-2 text-xs">Save</button>
                  <button type="button" disabled={saving} onClick={() => setEditing(null)} className="text-xs">Cancel</button>
                </form> : <>
                <button type="button" onClick={() => onOpen(c.id)} className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm hover:text-foreground" aria-current={c.id === activeId}>
                  {c.title}<span className="block text-[11px] text-muted-foreground">{new Date(c.updated_at).toLocaleString()}</span>
                </button>
                <button type="button" aria-label={`Rename conversation ${c.title}`} onClick={() => { setEditing(c.id); setTitle(c.title); }} className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground"><Pencil className="size-4" /></button>
                {confirm === c.id
                  ? <span className="mr-1 flex gap-1 text-xs"><button type="button" onClick={() => { setConfirm(null); onDelete(c.id); }} className="rounded-full px-2 py-1 text-destructive hover:bg-destructive/10">Delete</button><button type="button" onClick={() => setConfirm(null)} className="rounded-full px-2 py-1 hover:bg-muted">Keep</button></span>
                  : <button type="button" onClick={() => setConfirm(c.id)} aria-label={`Delete conversation ${c.title}`} className="mr-1 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-destructive"><Trash2 className="size-4" /></button>}
                </>}
              </li>
            ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

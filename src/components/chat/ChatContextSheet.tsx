// "Talk to" switcher and the stored-notes card. Contexts change which stored notes Jackboy reads;
// they never claim another agent is connected.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Eye, Hexagon, Plus, FolderGit2, Bot } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getChatContextBrief, listChatContexts, saveChatContext } from "@/lib/chat-threads.functions";
import { agentKey, JACKBOY_KEY, projectKey, type ContextBrief, type ContextKind } from "@/lib/chat-context";

export type ContextChoice = { key: string; name: string; kind: ContextKind };
type Lists = Awaited<ReturnType<typeof listChatContexts>>;

const row = "flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-muted";
const field = "mt-1 block w-full rounded-xl border border-border bg-card px-3 py-2 text-sm";

export function ChatContextSheet({ open, onOpenChange, current, onSelect }: { open: boolean; onOpenChange: (o: boolean) => void; current: string; onSelect: (c: ContextChoice) => void }) {
  const list = useServerFn(listChatContexts);
  const save = useServerFn(saveChatContext);
  const [data, setData] = useState<Lists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", role: "", kind: "agent" as "agent" | "visual_observer", notes: "" });
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => list().then((d) => { setData(d); setError(null); }).catch((e) => setError((e as Error).message)), [list]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const add = async () => {
    setSaving(true); setError(null);
    try {
      const r = await save({ data: { name: form.name, role: form.role, kind: form.kind, projectId: null, notes: form.notes } });
      setAdding(false); setForm({ name: "", role: "", kind: "agent", notes: "" });
      await load();
      onSelect({ key: agentKey(r.id), name: form.name, kind: form.kind });
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  const pick = (c: ContextChoice) => { onSelect(c); onOpenChange(false); };
  const sel = (k: string) => (k === current ? "bg-muted" : "");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-96 max-w-[90vw] overflow-y-auto">
        <SheetHeader><SheetTitle>Talk to</SheetTitle><SheetDescription>Jackboy answers using only the stored notes for the agent or project you pick. Nothing gets connected or started.</SheetDescription></SheetHeader>
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-4 space-y-4">
          <button type="button" className={`${row} ${sel(JACKBOY_KEY)}`} aria-pressed={current === JACKBOY_KEY} onClick={() => pick({ key: JACKBOY_KEY, name: "Jackboy", kind: "jackboy" })}>
            <Hexagon className="mt-0.5 size-4 text-electric" aria-hidden /><span><span className="block font-medium">Jackboy</span><span className="text-xs text-muted-foreground">Your update and repair engineer, with live tools</span></span>
          </button>
          <section>
            <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agents</h3>
            {!data ? <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p> : data.agents.map((a) => (
              <button key={a.id} type="button" className={`${row} ${sel(agentKey(a.id))}`} aria-pressed={current === agentKey(a.id)} onClick={() => pick({ key: agentKey(a.id), name: a.name, kind: a.kind })}>
                {a.kind === "visual_observer" ? <Eye className="mt-0.5 size-4 text-silver" aria-hidden /> : <Bot className="mt-0.5 size-4 text-silver" aria-hidden />}
                <span className="min-w-0"><span className="block font-medium">{a.name}</span>
                  <span className="block text-xs text-muted-foreground">{a.role || "Agent"} · {a.hasNotes ? `notes ${a.notesUpdatedAt ? `updated ${new Date(a.notesUpdatedAt).toLocaleDateString()}` : "stored"}` : a.projectId ? "project notes only" : "no notes yet"}</span></span>
              </button>
            ))}
            {!adding ? <button type="button" onClick={() => setAdding(true)} className="mt-1 inline-flex items-center gap-1 px-3 py-1 text-xs text-electric hover:underline"><Plus className="size-3.5" />Add an agent</button> : (
              <form className="mt-2 space-y-2 rounded-xl border border-border p-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
                <label className="block text-xs text-muted-foreground">Name<input required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} /></label>
                <label className="block text-xs text-muted-foreground">Role<input maxLength={200} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={field} placeholder="What this agent does" /></label>
                <label className="block text-xs text-muted-foreground">Type<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })} className={field}><option value="agent">Agent</option><option value="visual_observer">Visual observer (describes, never diagnoses)</option></select></label>
                <label className="block text-xs text-muted-foreground">Notes (facts Jackboy may use)<textarea rows={4} maxLength={8000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={field} /></label>
                <div className="flex gap-2"><button type="submit" disabled={saving || !form.name.trim()} className="rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50">{saving ? "Saving…" : "Save agent"}</button><button type="button" onClick={() => setAdding(false)} className="rounded-full border border-border px-4 py-1.5 text-sm">Cancel</button></div>
              </form>
            )}
          </section>
          <section>
            <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Projects</h3>
            {data?.projects.map((p) => (
              <button key={p.id} type="button" className={`${row} ${sel(projectKey(p.id))}`} aria-pressed={current === projectKey(p.id)} onClick={() => pick({ key: projectKey(p.id), name: p.name, kind: "project" })}>
                <FolderGit2 className="mt-0.5 size-4 text-silver" aria-hidden /><span className="min-w-0"><span className="block truncate font-medium">{p.name}</span><span className="text-xs text-muted-foreground">{p.hasNotes ? "Project notes stored" : "No project notes yet"}{p.hasRepo ? " · GitHub linked" : ""}</span></span>
              </button>
            ))}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Shows exactly which stored notes Jackboy will use; agent notes are editable by the owner. */
export function ContextNotesCard({ contextKey, onClose }: { contextKey: string; onClose?: () => void }) {
  const get = useServerFn(getChatContextBrief);
  const save = useServerFn(saveChatContext);
  const [state, setState] = useState<{ brief: ContextBrief; ownerNotes: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const load = useCallback(() => get({ data: { key: contextKey } }).then((s) => { setState(s); setDraft(s.ownerNotes); setError(null); }).catch((e) => setError((e as Error).message)), [get, contextKey]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <p role="alert" className="my-3 text-sm text-destructive">{error}</p>;
  if (!state) return <p className="my-3 text-sm text-muted-foreground">Reading stored notes…</p>;
  const b = state.brief;
  const isAgent = b.key.startsWith("agent:");
  const store = async () => {
    setError(null); setSaved(null);
    try {
      await save({ data: { id: b.key.slice(6), name: b.name, role: b.role, kind: b.kind === "visual_observer" ? "visual_observer" : "agent", projectId: b.projectId, notes: draft } });
      setEditing(false); setSaved("Notes saved and logged."); await load();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <section aria-label={`Stored notes for ${b.name}`} className="my-4 rounded-2xl border border-border bg-card/60 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div><p className="font-semibold text-silver">{b.name}</p><p className="text-xs text-muted-foreground">{b.role}{b.kind === "visual_observer" ? " · describes what is visible, never diagnoses" : ""}</p></div>
        {onClose && <button type="button" onClick={onClose} className="text-xs text-muted-foreground underline">Hide</button>}
      </div>
      {b.notes.length === 0 && b.work.length === 0 ? (
        <p className="mt-3 text-muted-foreground">No notes are stored for {b.name} yet. Jackboy will say so instead of guessing.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {b.notes.map((n) => <li key={n.label}><p className="text-xs text-muted-foreground">{n.label}{n.updatedAt ? ` · ${new Date(n.updatedAt).toLocaleDateString()}` : ""}</p><p className="line-clamp-4 whitespace-pre-wrap">{n.text}</p></li>)}
          {b.work.length > 0 && <li><p className="text-xs text-muted-foreground">Recent work notes</p><ul className="mt-1 space-y-1">{b.work.map((w, i) => <li key={i} className="text-xs">{new Date(w.at).toLocaleDateString()} · {w.kind}: {w.summary}</li>)}</ul></li>}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        {isAgent && !editing && <button type="button" onClick={() => setEditing(true)} className="text-electric underline">{state.ownerNotes ? "Edit notes" : "Add notes"}</button>}
        {b.projectId && <Link to="/project/$id" params={{ id: b.projectId }} className="text-electric underline">Open {b.projectName ?? "project"}</Link>}
        {saved && <span role="status" className="text-success">{saved}</span>}
      </div>
      {editing && <div className="mt-2 space-y-2">
        <label htmlFor="ctx-notes" className="sr-only">Notes about {b.name}</label>
        <textarea id="ctx-notes" rows={6} maxLength={8000} value={draft} onChange={(e) => setDraft(e.target.value)} className={field} placeholder={`Facts about ${b.name} Jackboy may rely on`} />
        <div className="flex gap-2"><button type="button" onClick={() => void store()} className="rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground">Save notes</button><button type="button" onClick={() => { setEditing(false); setDraft(state.ownerNotes); }} className="rounded-full border border-border px-4 py-1.5 text-sm">Cancel</button></div>
      </div>}
    </section>
  );
}

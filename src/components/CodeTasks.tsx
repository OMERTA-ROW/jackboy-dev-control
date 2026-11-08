import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { codeVoiceDecision, parseCodeCommand, type CodeCard } from "@/lib/code";
import { CodeUndoButton } from "./CodeUndoButton";
import { VerifiedActivity } from "./chat/ChatActivity";

async function call(body?: unknown, id?: string): Promise<CodeCard> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Sign in to use CODE.");
  const r = await fetch(id ? `/api/code?id=${encodeURIComponent(id)}` : "/api/code", {
    method: id ? "GET" : "POST", headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
    ...(id ? {} : { body: JSON.stringify(body) }),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error ?? "CODE request failed.");
  return result as CodeCard;
}

/** CODE lives inside the existing conversation. No alternate chat, microphone, or memory store. */
export function useCodeTasks() {
  const [cards, setCards] = useState<CodeCard[]>([]), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const current = useRef(cards), storage = useRef<string | null>(null), inflight = useRef(false);
  useEffect(() => { current.current = cards; }, [cards]);
  const save = useCallback((card: CodeCard) => {
    setCards(previous => {
      const old = previous.find(p => p.id === card.id);
      const next = [...previous.filter(p => p.id !== card.id), { ...card, ...(card.status === "pending" && (card.nonce || old?.nonce) ? { nonce: card.nonce ?? old!.nonce! } : {}) }].slice(-10);
      current.current = next;
      // Store only job identifiers and pending single-use nonces, never bearer tokens or prompts.
      try { if (storage.current) sessionStorage.setItem(storage.current, JSON.stringify(next.map(c => ({ id: c.id, ...(c.status === "pending" && c.nonce ? { nonce: c.nonce } : {}) })))); } catch { /* optional continuity */ }
      return next;
    });
  }, []);
  useEffect(() => {
    let mounted = true, generation = 0;
    const restore = async (uid: string | undefined) => {
      const version = ++generation;
      storage.current = uid ? `jackboy.code.jobs.${uid}` : null;
      setCards([]); current.current = []; setError(null);
      if (!uid) return;
      try {
        const saved = JSON.parse(sessionStorage.getItem(storage.current!) ?? "[]") as { id: string; nonce?: string }[];
        const results = await Promise.allSettled(saved.slice(-10).map(async s => ({ ...(await call(undefined, s.id)), ...(s.nonce ? { nonce: s.nonce } : {}) })));
        if (mounted && generation === version) results.forEach(r => { if (r.status === "fulfilled") save(r.value); });
      } catch { /* Invalid or inaccessible history never grants access. */ }
    };
    void supabase.auth.getSession().then(({ data }) => restore(data.session?.user.id));
    const { data } = supabase.auth.onAuthStateChange((event, session) => { if (event === "SIGNED_OUT" || event === "SIGNED_IN") void restore(session?.user.id); });
    return () => { mounted = false; data.subscription.unsubscribe(); };
  }, [save]);
  const act = useCallback(async (op: string, card: CodeCard, decision?: "allow" | "deny") => {
    if (inflight.current) return;
    inflight.current = true; setBusy(true); setError(null);
    try { save(await call({ op, id: card.id, ...(decision ? { decision, nonce: card.nonce } : {}) })); }
    catch (e) { setError(e instanceof Error ? e.message : "CODE request failed."); }
    finally { inflight.current = false; setBusy(false); }
  }, [save]);
  const submit = useCallback(async (text: string): Promise<boolean> => {
    const command = parseCodeCommand(text);
    if (command) {
      if (inflight.current) throw new Error("CODE is checking another request. Wait before sending again.");
      inflight.current = true; setBusy(true); setError(null);
      try { save(await call({ op: "request", ...command })); }
      catch (e) { const message = e instanceof Error ? e.message : "CODE is blocked."; setError(message); throw new Error(message); }
      finally { inflight.current = false; setBusy(false); }
      return true;
    }
    const pending = current.current.find(c => c.status === "pending" && codeVoiceDecision(text, c.id));
    if (!pending) return false;
    await act("decide", pending, codeVoiceDecision(text, pending.id)!);
    return true;
  }, [act, save]);
  // Poll actual GitHub evidence; avoid overlapping requests or endless polling of terminal runs.
  useEffect(() => {
    let stopped = false;
    const timer = setInterval(() => {
      if (inflight.current || document.hidden) return;
      const active = current.current.filter(c => c.status === "allowed" && c.run?.status !== "completed");
      if (!active.length) return;
      inflight.current = true;
      void Promise.allSettled(active.map(c => call(undefined, c.id))).then(results => {
        if (!stopped) results.forEach(r => { if (r.status === "fulfilled") save(r.value); else setError("CODE progress could not be refreshed. Use Refresh to retry."); });
      }).finally(() => { inflight.current = false; });
    }, 8000);
    return () => { stopped = true; clearInterval(timer); };
  }, [save]);
  const refresh = async (card: CodeCard) => {
    try { save(await call(undefined, card.id)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Refresh failed"); }
  };
  return { cards, error, busy, submit, act, refresh, receive: save };
}

export function CodeTasks({ tasks }: { tasks: ReturnType<typeof useCodeTasks> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!tasks.cards.length && !tasks.error && !tasks.busy) return null;
  return <section aria-label="CODE jobs" className="my-5 space-y-3">
    {tasks.busy && <p role="status" className="text-sm text-muted-foreground">CODE is checking the request…</p>}
    {tasks.error && <p role="alert" className="text-sm text-destructive">{tasks.error}</p>}
    {tasks.cards.map(card => {
      const pending = card.status === "pending", expired = Date.parse(card.expiresAt) <= now;
      const terminal = card.run?.status === "completed";
      return <article key={card.id} aria-label={`CODE job ${card.id}`} className="rounded-2xl border border-border p-4 text-sm">
        <p className="font-semibold">CODE · {card.repo}</p>
        <p className="mt-1 whitespace-pre-wrap">{card.instruction}</p>
        <p className="mt-2 break-all text-xs text-muted-foreground">Job / approval ID: {card.id}</p>
        <p role="status" className="mt-1">{pending ? expired ? "Approval expired" : "Waiting for your approval" : card.run ? `${card.run.status} · ${card.run.conclusion ?? "in progress"}` : card.status}</p>
        {pending && <>
          <p className="mt-2">Target: {card.repo}. Permissions: {card.permissions.join("; ")}.</p>
          <p className="mt-1">Configured task spend reservation at request creation: {card.taskBudgetUsd == null ? "unavailable" : `up to $${card.taskBudgetUsd.toFixed(2)}`}. This is a ceiling, not a cost forecast or daily-cap guarantee; runtime admission rechecks current controls.</p>
          <p className="mt-1 text-xs">Expires {new Date(card.expiresAt).toLocaleTimeString()}. Voice response: “Allow CODE {card.id}” or “Deny CODE {card.id}”.</p>
          <div className="mt-3 flex gap-3">
            <button type="button" disabled={tasks.busy || expired || !card.nonce} onClick={() => void tasks.act("decide", card, "allow")} className="rounded-full bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40">Allow once</button>
            <button type="button" disabled={tasks.busy || expired || !card.nonce} onClick={() => void tasks.act("decide", card, "deny")} className="rounded-full border border-border px-4 py-2 disabled:opacity-40">Deny</button>
          </div>
        </>}
        {card.outcome && <p className="mt-2 text-xs text-muted-foreground">{card.outcome}</p>}
        {card.run?.jobs.map(job => <VerifiedActivity key={job.name}
          label={job.name} running={job.status === "in_progress" || job.status === "queued"}
          failed={["failure", "cancelled", "timed_out", "action_required"].includes(job.conclusion ?? "")}
          details={[`GitHub job: ${job.name}`, `Status: ${job.status}`, ...(job.conclusion ? [`Conclusion: ${job.conclusion}`] : [])]} />)}
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <a href={`/project/${encodeURIComponent(card.projectId)}`} className="text-electric underline">Project</a>
          {card.run && <a href={card.run.url} target="_blank" rel="noopener noreferrer" className="text-electric underline">Progress and logs</a>}
          {card.run?.pr && <a href={card.run.pr} target="_blank" rel="noopener noreferrer" className="text-electric underline">Review draft PR</a>}
          {card.run?.pr && <CodeUndoButton requestId={card.id} />}
          {card.run?.downloads.map(d => <a key={d.url} href={d.url} target="_blank" rel="noopener noreferrer" className="text-electric underline">Download {d.name}</a>)}
          <button type="button" onClick={() => void tasks.refresh(card)} className="underline">Refresh</button>
          {card.run && !terminal && <button type="button" disabled={tasks.busy} onClick={() => void tasks.act("cancel", card)} className="text-destructive underline">Cancel job</button>}
          {terminal && ["failure", "cancelled", "timed_out"].includes(card.run?.conclusion ?? "") && <button type="button" disabled={tasks.busy} onClick={() => void tasks.act("retry", card)} className="underline">Request retry approval</button>}
        </div>
      </article>;
    })}
  </section>;
}

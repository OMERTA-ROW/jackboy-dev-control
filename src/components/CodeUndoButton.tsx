// One-press Undo for a CODE change. A draft PR closes right away; a merged change needs a fresh passkey,
// then Jackboy opens a revert and merges it only after its checks pass.
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { getUndoState, undoCodeChange } from "@/lib/owner-notify.functions";
import { undoTarget, UNDO_STEP_UP } from "@/lib/code-undo";
import { useStepUp } from "@/lib/step-up-client";
import type { UndoState } from "@/lib/code-undo.server";

const STATUS_TEXT: Record<string, string> = {
  started: "Undo in progress…",
  waiting_checks: "Revert opened; Jackboy merges it once checks pass.",
  done: "Undone.",
  failed: "Undo didn't finish.",
  refused: "Undo refused to protect newer work.",
};

export function CodeUndoButton({ requestId, initial }: { requestId: string; initial?: UndoState }) {
  const load = useServerFn(getUndoState), run = useServerFn(undoCodeChange), stepUp = useStepUp();
  const [state, setState] = useState<UndoState | null>(initial ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setState(await load({ data: { requestId } })); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Undo status unavailable."); }
  }, [load, requestId]);
  useEffect(() => { if (!initial) void refresh(); }, [initial, refresh]);

  const press = async () => {
    if (!state?.kind) return;
    setBusy(true); setError(null);
    try {
      if (state.kind === "close_draft") setState(await run({ data: { requestId } }));
      else {
        setState(await stepUp(UNDO_STEP_UP, undoTarget(requestId), {
          apply: (grantId) => run({ data: { requestId, grantId } }),
          applyingText: "Passkey confirmed. Building the revert…",
          doneText: (s) => (s.undo?.status === "refused" ? "Refused: newer work changed the same files." : "Revert opened. Jackboy merges it after checks pass."),
        }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Undo failed.");
      await refresh();
    } finally { setBusy(false); }
  };

  if (!state) return error ? <span className="text-xs text-destructive">{error}</span> : null;
  const u = state.undo;
  const canPress = !state.blocked && !!state.kind;
  return (
    <span className="inline-flex flex-col gap-1 text-xs">
      {u && u.status !== "failed" ? (
        <span role="status" className={u.status === "done" ? "text-emerald" : u.status === "refused" ? "text-destructive" : "text-muted-foreground"}>
          {STATUS_TEXT[u.status] ?? u.status}{u.detail ? ` ${u.detail}` : ""}
          {u.revertPrUrl && <> <a href={u.revertPrUrl} target="_blank" rel="noopener noreferrer" className="text-electric underline">Revert PR</a></>}
          {u.status === "done" && u.republishNeeded && <> Republish the site if this change was live.</>}
        </span>
      ) : (
        <span className="inline-flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void press()} disabled={!canPress || busy} title={state.blocked ?? undefined}
            className="inline-flex items-center gap-1 underline disabled:opacity-40 disabled:no-underline">
            <RotateCcw className="h-3 w-3" aria-hidden />
            {busy ? "Undoing…" : state.kind === "revert_merged" ? "Undo (passkey)" : "Undo (close draft PR)"}
          </button>
          {state.blocked && <span className="text-muted-foreground">{state.blocked}</span>}
          {u?.status === "failed" && <span className="text-destructive">Last try failed: {u.detail}</span>}
        </span>
      )}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </span>
  );
}

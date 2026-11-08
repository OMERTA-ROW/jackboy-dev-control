import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useServerFn } from "@tanstack/react-start";
import { createResearchHandoff } from "@/lib/owner-records.functions";
import { CREATOR_LABEL, meta, type Finding } from "@/lib/discovery";

const field = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

export function SendToOmni({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(() => ({
    hypothesis: finding.idea,
    noveltyCaveat: "Novelty not established. Requires professional patent and prior-art search before any claim.",
    feasibility: finding.scores.feasibility,
    requirements: `- Validate core claim from: ${finding.title}\n- Define MVP scope\n- Test plan and success metrics`,
    risk: "medium" as "low" | "medium" | "high", priority: "medium" as "low" | "medium" | "high", estCost: 5000,
  }));
  const create = useServerFn(createResearchHandoff);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await create({ data: { findingId: finding.id, title: (finding.idea || finding.title).slice(0, 300), sources: [finding.url, `Creator: ${CREATOR_LABEL[meta(finding).creator]} — IP remains with the original creator; consent required before use`], ...f } });
      toast.success("Saved to your OMNI review queue — awaiting your approval. Nothing was sent.");
      setOpen(false);
    } catch (err) {
      toast.error(`Not saved: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"><Send className="h-3.5 w-3.5" />Send to OMNI</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Send to OMNI</DialogTitle>
            <DialogDescription>Creates a pending handoff for your approval. OMNI is not connected — nothing is sent automatically.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-3 text-sm">
            <div className="text-xs text-muted-foreground">Source: <span className="font-mono">{finding.url}</span></div>
            <label className="block">Technical hypothesis (AI, unverified)<textarea required value={f.hypothesis} onChange={(e) => setF({ ...f, hypothesis: e.target.value })} className={field} rows={2} /></label>
            <label className="block">Novelty caveat<textarea required value={f.noveltyCaveat} onChange={(e) => setF({ ...f, noveltyCaveat: e.target.value })} className={field} rows={2} /></label>
            <label className="block">Proposed requirements<textarea value={f.requirements} onChange={(e) => setF({ ...f, requirements: e.target.value })} className={`${field} font-mono text-xs`} rows={4} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label>Feasibility (0–5)<input type="number" min={0} max={5} value={f.feasibility} onChange={(e) => setF({ ...f, feasibility: Number(e.target.value) })} className={field} /></label>
              <label>Est. build cost ($, estimate)<input type="number" min={0} value={f.estCost} onChange={(e) => setF({ ...f, estCost: Number(e.target.value) })} className={field} /></label>
              <label>Risk<select value={f.risk} onChange={(e) => setF({ ...f, risk: e.target.value as never })} className={field}><option>low</option><option>medium</option><option>high</option></select></label>
              <label>Priority<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as never })} className={field}><option>low</option><option>medium</option><option>high</option></select></label>
            </div>
            <button type="submit" disabled={busy} className="w-full rounded-md bg-primary py-2 font-medium text-primary-foreground disabled:opacity-50">{busy ? "Saving…" : "Add to pending queue"}</button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

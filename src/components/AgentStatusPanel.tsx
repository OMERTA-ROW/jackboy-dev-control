import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAgentStatus } from "@/lib/agent-status.functions";
import { speechSupport } from "@/components/ChatVoice";
import { useEffect, useState } from "react";

function Row({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  const tone = ok === true ? "text-success" : ok === false ? "text-destructive" : "text-muted-foreground";
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 py-2 text-sm last:border-0">
      <span className="text-foreground">{label}</span>
      <span className={`text-right ${tone}`}>{detail}</span>
    </div>
  );
}

export function AgentStatusPanel() {
  const fetchStatus = useServerFn(getAgentStatus);
  const q = useQuery({ queryKey: ["agent-status"], queryFn: () => fetchStatus(), refetchInterval: 60_000 });
  const [voice, setVoice] = useState<ReturnType<typeof speechSupport>>({ listen: "none", speak: false });
  useEffect(() => setVoice(speechSupport()), []);
  const s = q.data;
  return (
    <section aria-label="Agent status" className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">Agent Status</h2>
        <button className="text-xs text-primary hover:underline" onClick={() => q.refetch()}>{q.isFetching ? "Checking…" : "Recheck"}</button>
      </div>
      {q.dataUpdatedAt > 0 && !q.isFetching && <p className="mb-1 text-xs text-muted-foreground" role="status">Checked at {new Date(q.dataUpdatedAt).toLocaleTimeString()}</p>}
      {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
      {!s && !q.error && <p className="text-sm text-muted-foreground">Checking real connections…</p>}
      {s && (
        <>
          <Row label="AI model" ok={s.model.connected} detail={s.model.connected ? `${s.model.name} — connected` : s.model.detail} />
          <Row label="Voice (this browser)" ok={voice.listen !== "none" || voice.speak} detail={`${voice.listen === "browser" ? "mic input (browser)" : voice.listen === "record" ? "mic input (recorded, server transcription)" : "no mic input"} · ${voice.speak ? "spoken replies" : "no spoken replies"}`} />
          <Row label="Repo access" ok={s.github.connected} detail={s.github.connected ? `${s.github.usableRepos} private repos editable` : s.github.detail} />
          <Row label="Test results" ok={s.ci.readable} detail={s.ci.detail} />
          <Row label="Browser testing" ok={false} detail={s.browserRunner.detail} />
          <Row label="Last code edit" ok={null} detail={s.lastEdit ? `${s.lastEdit.summary.slice(0, 80)} · ${new Date(s.lastEdit.at).toLocaleString()}` : "None yet"} />
          <Row label="Last test" ok={null} detail={s.lastTest ? s.lastTest.summary.slice(0, 90) : "None recorded"} />
          <Row label="Draft PRs / waiting approvals" ok={null} detail={`${s.openPrs} / ${s.queuedApprovals}`} />
          <Row label="Memory" ok={null} detail={`${s.memoryEntries} entries · ${s.notion.detail}`} />
        </>
      )}
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneCall, PhoneOff, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useLiveVoice, type LiveEvent } from "@/hooks/use-live-voice";
import { VoiceOrb, type OrbMode } from "@/components/VoiceOrb";

type Row = { role: "user" | "assistant"; text: string };
const STATUS: Record<string, string> = { idle: "Not connected", connecting: "Connecting…", connected: "Live — speak any time", stopping: "Ending call…", closed: "Call ended" };

/**
 * Two-way live voice with Jackboy (GPT Live over WebRTC through the app's owner-only relay).
 * Status, captions and the orb come only from real call events. Voice can only read Jackboy's state;
 * approvals, merges, deploys and permission changes stay in the screens with passkey step-up.
 */
export function LiveVoiceCall({ chatContext, onTranscript }: { chatContext: () => string; onTranscript: (rows: Row[]) => void }) {
  const token = useRef<string | null>(null);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { token.current = data.session?.access_token ?? null; });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => { token.current = s?.access_token ?? null; });
    return () => data.subscription.unsubscribe();
  }, []);
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef<Row[]>([]);
  const [activity, setActivity] = useState<"listening" | "speaking" | "thinking">("listening");
  const [seconds, setSeconds] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const level = useRef(0);
  const quiet = useRef<ReturnType<typeof setTimeout>>();

  const push = (role: Row["role"], delta: string) => {
    const r = rowsRef.current, last = r.at(-1);
    rowsRef.current = last?.role === role ? [...r.slice(0, -1), { role, text: last.text + delta }] : [...r, { role, text: delta }];
    setRows(rowsRef.current);
  };
  const onEvent = (e: LiveEvent) => {
    const delta = typeof e["delta"] === "string" ? (e["delta"] as string) : "";
    if (e.type === "session.input_transcript.delta" && delta) { push("user", delta); setActivity("listening"); level.current = 0.8; }
    else if (e.type === "session.output_transcript.delta" && delta) {
      push("assistant", delta); setActivity("speaking"); level.current = 1;
      clearTimeout(quiet.current); quiet.current = setTimeout(() => setActivity("listening"), 1500);
    } else if (e.type === "app.delegation.pending") setActivity("thinking");
    else if (e.type === "app.jackboy.status") setNotice("Jackboy checked live project data.");
    else if (e.type === "session.usage.updated" || e.type === "session.closed") { const s = e.usage?.seconds; if (typeof s === "number") setSeconds(Math.max(15, s)); }
    else if (e.type === "error" && e.error?.message) setNotice(e.error.message);
    else if (e.type === "app.closed" && rowsRef.current.length) { onTranscript(rowsRef.current); rowsRef.current = []; }
  };
  const call = useLiveVoice({ onEvent, getToken: () => token.current, getContext: chatContext });
  const live = call.status === "connecting" || call.status === "connected" || call.status === "stopping";
  const mode: OrbMode = call.error ? "error" : call.status === "connecting" ? "thinking" : call.status !== "connected" ? "idle" : call.muted ? "muted" : activity;

  const start = () => { setRows([]); rowsRef.current = []; setSeconds(null); setNotice(null); setActivity("listening"); call.start(); };

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <VoiceOrb mode={mode} level={level} onTap={live ? call.stop : start} size={56} />
        <div className="min-w-0 flex-1 text-xs">
          <p className="font-medium" aria-live="polite">Live voice: {STATUS[call.status] ?? call.status}{call.muted && call.status === "connected" ? " · mic muted" : ""}</p>
          {seconds !== null && <p className="text-muted-foreground">Billed voice time: {seconds}s</p>}
          {notice && <p className="text-muted-foreground">{notice}</p>}
          {call.error && <p role="alert" className="text-destructive">{call.error}</p>}
        </div>
        <div className="flex gap-2">
          {!live ? (
            <button type="button" onClick={start} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-xs hover:border-electric"><PhoneCall className="h-4 w-4" />Start voice call</button>
          ) : (
            <>
              <button type="button" disabled={call.status !== "connected"} onClick={() => call.setMuted(!call.muted)} aria-pressed={call.muted} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50">{call.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}{call.muted ? "Unmute" : "Mute"}</button>
              <button type="button" onClick={call.stop} className="inline-flex items-center gap-1 rounded-md border border-destructive/50 px-3 py-2 text-xs text-destructive"><PhoneOff className="h-4 w-4" />End call</button>
            </>
          )}
          {call.playbackBlocked && <button type="button" onClick={call.resumePlayback} className="inline-flex items-center gap-1 rounded-md border border-electric px-3 py-2 text-xs"><Play className="h-4 w-4" />Play audio</button>}
        </div>
      </div>
      <audio ref={call.audioRef} controls className="mt-2 h-8 w-full" aria-label="Jackboy voice audio" />
      {rows.length > 0 && (
        <ol className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs" aria-label="Live captions">
          {rows.map((r, i) => <li key={i}><span className="text-muted-foreground">{r.role === "user" ? "You" : "Jackboy"}:</span> {r.text}</li>)}
        </ol>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">The mic is used only during a call you start. Voice can look up project status and blockers; approving, merging, deploying or changing permissions still needs the screens and your passkey. The call transcript is added to this chat when it ends.</p>
    </div>
  );
}

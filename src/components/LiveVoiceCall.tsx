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
export function LiveVoiceCall({ chatContext, onTranscript, variant = "docked" }: { chatContext: () => string; onTranscript: (rows: Row[]) => void; variant?: "expanded" | "docked" }) {
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
  const quiet = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  const start = () => { try { localStorage.setItem("jackboy.live.optin", "1"); } catch { /* optional */ } setRows([]); rowsRef.current = []; setSeconds(null); setNotice(null); setActivity("listening"); call.start(); };
  const end = () => { try { localStorage.setItem("jackboy.live.optin", "0"); } catch { /* optional */ } call.stop(); };
  // No repeated "Start call": if the owner opted in before AND the browser already granted the mic, reconnect on open.
  // Never prompts for the mic silently; first use always needs a tap.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return; resumed.current = true;
    let optin = false; try { optin = localStorage.getItem("jackboy.live.optin") === "1"; } catch { /* optional */ }
    if (!optin || !navigator.permissions?.query) return;
    const t = setTimeout(() => {
      void navigator.permissions.query({ name: "microphone" as PermissionName }).then((p) => { if (p.state === "granted" && token.current) start(); }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, []);

  const expanded = variant === "expanded";
  const controls = (
    <div className={`flex flex-wrap gap-2 ${expanded ? "justify-center" : ""}`}>
      {!live ? (
        <button type="button" onClick={start} className="inline-flex min-h-11 items-center gap-1 rounded-md border border-border bg-background/80 px-3 py-2 text-xs hover:border-electric"><PhoneCall className="h-4 w-4" />Talk to Jackboy</button>
      ) : (
        <>
          <button type="button" disabled={call.status !== "connected"} onClick={() => call.setMuted(!call.muted)} aria-pressed={call.muted} className="inline-flex min-h-11 items-center gap-1 rounded-md border border-border bg-background/80 px-3 py-2 text-xs disabled:opacity-50">{call.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}{call.muted ? "Unmute" : "Mute"}</button>
          <button type="button" onClick={end} className="inline-flex min-h-11 items-center gap-1 rounded-md border border-destructive/50 bg-background/80 px-3 py-2 text-xs text-destructive"><PhoneOff className="h-4 w-4" />End call</button>
        </>
      )}
      {call.playbackBlocked && <button type="button" onClick={call.resumePlayback} className="inline-flex min-h-11 items-center gap-1 rounded-md border border-electric px-3 py-2 text-xs"><Play className="h-4 w-4" />Play audio</button>}
    </div>
  );
  const status = (
    <div className={`min-w-0 text-xs ${expanded ? "text-center" : "flex-1"}`}>
      <p className="font-medium" aria-live="polite"><span className={`mr-1 inline-block size-2 rounded-full ${call.status === "connected" && !call.muted ? "bg-success" : call.status === "connected" ? "bg-warning" : "bg-muted-foreground/50"}`} aria-hidden />Mic {call.status === "connected" ? (call.muted ? "muted" : "on") : "off"} · {STATUS[call.status] ?? call.status}</p>
      {seconds !== null && <p className="text-muted-foreground">Billed voice time: {seconds}s</p>}
      {notice && <p className="text-muted-foreground">{notice}</p>}
      {call.error && <p role="alert" className="text-destructive">{call.error}</p>}
    </div>
  );

  return (
    <div className={expanded ? "flex flex-col items-center gap-3 px-4 py-4" : "px-3 py-2"}>
      {expanded ? (
        <>
          <VoiceOrb mode={mode} level={level} onTap={live ? end : start} size={168} />
          {status}{controls}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <VoiceOrb mode={mode} level={level} onTap={live ? end : start} size={44} />
          {status}{controls}
        </div>
      )}
      <audio ref={call.audioRef} className="hidden" aria-label="Jackboy voice audio" />
      {rows.length > 0 && (
        <ol className={`max-h-28 w-full space-y-1 overflow-y-auto text-xs ${expanded ? "max-w-md" : "mt-1"}`} aria-label="Live captions">
          {rows.map((r, i) => <li key={i}><span className="text-muted-foreground">{r.role === "user" ? "You" : "Jackboy"}:</span> {r.text}</li>)}
        </ol>
      )}
      {expanded && <p className="max-w-md text-center text-[11px] text-muted-foreground">The mic turns on only after you tap the orb (and reconnects next visit only if your browser already allowed it). Live calls use the built-in realtime voice; typed replies are read aloud in the Jackboy voice. Approving, merging, deploying or changing permissions still needs the screens and your passkey. What you both say joins this chat when the call ends.</p>}
    </div>
  );
}

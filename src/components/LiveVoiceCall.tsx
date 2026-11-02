import { useEffect, useRef, useState } from "react";
import { AudioLines, Mic, MicOff, PhoneOff, Play, RotateCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useLiveVoice, type LiveEvent } from "@/hooks/use-live-voice";
import { VoiceOrb, type OrbMode } from "@/components/VoiceOrb";

export type LiveRow = { role: "user" | "assistant"; text: string };
const STATUS: Record<string, string> = { idle: "Voice off", connecting: "Connecting…", connected: "Listening", stopping: "Ending…", closed: "Voice off" };

/**
 * Two-way live voice with Jackboy (GPT Live over WebRTC through the app's owner-only relay).
 * Captions stream into the chat via onLiveRows; when the call ends they are committed via onTranscript.
 * Voice can only read Jackboy's state; approvals, merges, deploys and permission changes stay on screens with passkey step-up.
 */
export function useLiveCall({ chatContext, onLiveRows, onTranscript }: { chatContext: () => string; onLiveRows: (rows: LiveRow[]) => void; onTranscript: (rows: LiveRow[]) => void }) {
  const token = useRef<string | null>(null);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { token.current = data.session?.access_token ?? null; });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => { token.current = s?.access_token ?? null; });
    return () => data.subscription.unsubscribe();
  }, []);
  const rowsRef = useRef<LiveRow[]>([]);
  const [activity, setActivity] = useState<"listening" | "speaking" | "thinking">("listening");
  const level = useRef(0);
  const quiet = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const push = (role: LiveRow["role"], delta: string) => {
    const r = rowsRef.current, last = r.at(-1);
    rowsRef.current = last?.role === role ? [...r.slice(0, -1), { role, text: last.text + delta }] : [...r, { role, text: delta }];
    onLiveRows(rowsRef.current);
  };
  const commit = () => { if (rowsRef.current.length) onTranscript(rowsRef.current); rowsRef.current = []; onLiveRows([]); };
  const onEvent = (e: LiveEvent) => {
    const delta = typeof e["delta"] === "string" ? (e["delta"] as string) : "";
    if (e.type === "session.input_transcript.delta" && delta) { push("user", delta); setActivity("listening"); level.current = 0.8; }
    else if (e.type === "session.output_transcript.delta" && delta) {
      push("assistant", delta); setActivity("speaking"); level.current = 1;
      clearTimeout(quiet.current); quiet.current = setTimeout(() => setActivity("listening"), 1500);
    } else if (e.type === "app.delegation.pending") setActivity("thinking");
    else if (e.type === "app.closed") commit();
  };
  const call = useLiveVoice({ onEvent, getToken: () => token.current, getContext: chatContext });
  const live = call.status === "connecting" || call.status === "connected" || call.status === "stopping";
  const mode: OrbMode = call.error ? "error" : call.status === "connecting" ? "thinking" : call.status !== "connected" ? "idle" : call.muted ? "muted" : activity;
  const start = () => { try { localStorage.setItem("jackboy.live.optin", "1"); } catch { /* optional */ } commit(); setActivity("listening"); call.start(); };
  const end = () => { try { localStorage.setItem("jackboy.live.optin", "0"); } catch { /* optional */ } call.stop(); };
  // Session continuity: reconnect on return only if the owner left a call on AND the browser already granted the mic.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return; resumed.current = true;
    let optin = false; try { optin = localStorage.getItem("jackboy.live.optin") === "1"; } catch { /* optional */ }
    if (!optin || !navigator.permissions?.query) return;
    const t = setTimeout(() => { void navigator.permissions.query({ name: "microphone" as PermissionName }).then((p) => { if (p.state === "granted" && token.current) start(); }).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, []);
  return { call, live, mode, level, start, end };
}

export type LiveCall = ReturnType<typeof useLiveCall>;

const pill = "inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs hover:border-electric focus-visible:outline-2 focus-visible:outline-electric disabled:opacity-50";

/** Composer button that starts a voice conversation. */
export function StartVoiceButton({ v }: { v: LiveCall }) {
  return (
    <button type="button" onClick={v.start} aria-label="Start voice conversation" title="Talk with Jackboy" className="inline-flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-electric">
      <AudioLines className="size-4" />
    </button>
  );
}

/** Slim bar above the composer while a voice conversation is running. */
export function LiveCallBar({ v }: { v: LiveCall }) {
  const { call } = v;
  const audio = <audio ref={call.audioRef} className="hidden" aria-label="Jackboy voice audio" />;
  if (!v.live && !call.error) return audio;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-full border border-border bg-card/80 py-1 pl-1 pr-2 backdrop-blur">
      <VoiceOrb mode={v.mode} level={v.level} onTap={v.live ? v.end : v.start} size={36} />
      <span className="min-w-0 flex-1 truncate text-xs" aria-live="polite">
        {call.error ? <span role="alert" className="text-destructive">{call.error}</span> : call.muted ? "Muted" : v.mode === "speaking" ? "Jackboy is speaking — just talk to interrupt" : v.mode === "thinking" ? "Thinking…" : STATUS[call.status] ?? call.status}
      </span>
      {call.playbackBlocked && <button type="button" onClick={call.resumePlayback} className={pill}><Play className="size-4" />Play audio</button>}
      {call.error && !v.live && <button type="button" onClick={v.start} className={pill}><RotateCw className="size-4" />Reconnect</button>}
      {v.live && <button type="button" disabled={call.status !== "connected"} onClick={() => call.setMuted(!call.muted)} aria-pressed={call.muted} aria-label={call.muted ? "Unmute microphone" : "Mute microphone"} className={pill}>{call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}</button>}
      {v.live && <button type="button" onClick={v.end} aria-label="End voice conversation" className={`${pill} border-destructive/50 text-destructive`}><PhoneOff className="size-4" />End</button>}
      {audio}
    </div>
  );
}

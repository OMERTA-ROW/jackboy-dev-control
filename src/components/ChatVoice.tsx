import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Volume2, VolumeX, Square, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { redactTranscript } from "@/lib/voice-guard";

/**
 * Voice for Jackboy chat. Listening only starts when the owner taps the mic (never in the background).
 * Speech-to-text: the browser's SpeechRecognition when available; otherwise a recording sent once to the
 * owner-only /api/transcribe route (works on iPhone/iPad Safari). Audio is never stored.
 * The transcript lands in the text box so the owner can edit it before sending.
 * Spoken replies use the browser's speechSynthesis.
 */
type Rec = { start(): void; stop(): void; abort(): void; lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };
export type VoiceMode = "browser" | "record" | "none";
export type VoiceState = "idle" | "listening" | "processing" | "speaking" | "error";

export function speechSupport(): { listen: VoiceMode; speak: boolean } {
  if (typeof window === "undefined") return { listen: "none", speak: false };
  const w = window as any;
  const listen: VoiceMode = w.SpeechRecognition || w.webkitSpeechRecognition ? "browser"
    : typeof w.MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" ? "record" : "none";
  return { listen, speak: "speechSynthesis" in window };
}

function pickMime() {
  const M = (window as any).MediaRecorder;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) if (M?.isTypeSupported?.(t)) return t;
  return "";
}

export function useChatVoice(onTranscript: (text: string) => void) {
  const [support, setSupport] = useState<{ listen: VoiceMode; speak: boolean }>({ listen: "none", speak: false });
  const [state, setState] = useState<VoiceState>("idle");
  const [speakReplies, setSpeakReplies] = useState(false);
  const [error, setError] = useState("");
  const rec = useRef<Rec | null>(null);
  const media = useRef<{ r: MediaRecorder; stream: MediaStream; chunks: Blob[] } | null>(null);

  const releaseMic = () => { media.current?.stream.getTracks().forEach((t) => t.stop()); };
  useEffect(() => {
    setSupport(speechSupport());
    try { setSpeakReplies(localStorage.getItem("jackboy.chat.speak") === "1"); } catch { /* optional */ }
    return () => { rec.current?.abort(); if (media.current?.r.state === "recording") media.current.r.stop(); releaseMic(); if ("speechSynthesis" in window) window.speechSynthesis.cancel(); };
  }, []);

  const fail = (msg: string) => { setError(msg); setState("error"); };
  const stopSpeaking = () => { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); setState((s) => (s === "speaking" ? "idle" : s)); };
  const toggleSpeak = () => {
    const next = !speakReplies;
    setSpeakReplies(next);
    if (!next) stopSpeaking();
    try { localStorage.setItem("jackboy.chat.speak", next ? "1" : "0"); } catch { /* optional */ }
  };
  const speak = useCallback((text: string) => {
    if (!speakReplies || !("speechSynthesis" in window) || !text.trim()) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(redactTranscript(text).replace(/[`*#_>|]/g, "").slice(0, 1500));
    u.onend = () => setState("idle"); u.onerror = () => setState("idle");
    setState("speaking");
    window.speechSynthesis.speak(u);
  }, [speakReplies]);

  async function upload(blob: Blob) {
    setState("processing");
    try {
      const { data } = await supabase.auth.getSession();
      const fd = new FormData();
      fd.append("file", new File([blob], blob.type.includes("mp4") ? "speech.mp4" : "speech.webm", { type: blob.type.split(";")[0] || "audio/webm" }));
      const res = await fetch("/api/transcribe", { method: "POST", body: fd, headers: data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {} });
      const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) return fail(`${j.error ?? "Transcription failed."} You can type instead.`);
      if (!j.text) return fail("I didn't catch any words. Try again or type instead.");
      onTranscript(redactTranscript(j.text)); setState("idle"); setError("");
    } catch { fail("Couldn't reach the transcription service. Type instead."); }
  }

  const toggleListen = async () => {
    // Stop / interrupt
    if (state === "listening") {
      rec.current?.stop();
      if (media.current?.r.state === "recording") media.current.r.stop();
      return;
    }
    if (state === "processing") return;
    stopSpeaking(); setError("");
    if (support.listen === "browser") {
      const w = window as any; const R = w.SpeechRecognition || w.webkitSpeechRecognition;
      const r: Rec = new R();
      r.lang = navigator.language || "en-US"; r.interimResults = false; r.continuous = false;
      r.onresult = (e) => { const t = Array.from(e.results as ArrayLike<any>).map((x) => x[0]?.transcript ?? "").join(" ").trim(); if (t) onTranscript(redactTranscript(t)); };
      r.onerror = (e) => fail(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone permission was denied. Allow it in your browser settings, or type instead." : e.error === "no-speech" ? "I didn't hear anything. Try again or type instead." : `Voice input stopped (${e.error}). Type instead.`);
      r.onend = () => { setState((s) => (s === "listening" ? "idle" : s)); rec.current = null; };
      rec.current = r;
      try { r.start(); setState("listening"); } catch { fail("Couldn't start the microphone. Type instead."); }
      return;
    }
    if (support.listen === "record") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = pickMime();
        const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        r.onstop = () => { releaseMic(); const blob = new Blob(chunks, { type: r.mimeType || mime || "audio/webm" }); media.current = null; if (blob.size) void upload(blob); else fail("Nothing was recorded. Try again."); };
        media.current = { r, stream, chunks };
        r.start(); setState("listening");
        setTimeout(() => { if (media.current?.r === r && r.state === "recording") r.stop(); }, 60_000);
      } catch (e) {
        fail((e as Error).name === "NotAllowedError" ? "Microphone permission was denied. Allow it in your browser settings, or type instead." : "Couldn't start the microphone. Type instead.");
      }
      return;
    }
    fail("Voice input isn't supported in this browser. Type instead.");
  };
  return { support, state, listening: state === "listening", speaking: state === "speaking", speakReplies, error, toggleListen, toggleSpeak, stopSpeaking, speak };
}

const iconBtn = "inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-electric hover:text-foreground focus-visible:outline-2 focus-visible:outline-electric disabled:opacity-40";
const STATE_TEXT: Record<VoiceState, string> = { idle: "", listening: "Listening… tap to stop", processing: "Turning speech into text…", speaking: "Speaking…", error: "" };

export function VoiceButtons({ v }: { v: ReturnType<typeof useChatVoice> }) {
  return (
    <div className="flex items-center gap-1">
      {v.support.listen !== "none" ? (
        <button type="button" onClick={() => void v.toggleListen()} disabled={v.state === "processing"} aria-pressed={v.listening} aria-label={v.listening ? "Stop listening" : "Speak your message"} title={v.listening ? "Stop listening" : "Speak — words appear in the box so you can edit before sending"}
          className={`${iconBtn} ${v.listening ? "border-destructive text-destructive" : ""}`}>
          {v.state === "processing" ? <Loader2 className="size-4 animate-spin" /> : v.listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </button>
      ) : <span className="text-xs text-muted-foreground">Voice not supported here — type instead</span>}
      {v.support.speak && (
        <button type="button" onClick={v.toggleSpeak} aria-pressed={v.speakReplies} aria-label={v.speakReplies ? "Mute spoken replies" : "Read replies aloud"} title={v.speakReplies ? "Mute spoken replies" : "Read replies aloud"} className={iconBtn}>
          {v.speakReplies ? <Volume2 className="size-4 text-electric" /> : <VolumeX className="size-4" />}
        </button>
      )}
      {v.speaking && <button type="button" onClick={v.stopSpeaking} aria-label="Stop speaking" className={iconBtn}><Square className="size-3" /></button>}
      {STATE_TEXT[v.state] && <span aria-live="polite" data-voice-state={v.state} className={`text-xs ${v.listening ? "text-destructive" : "text-electric"}`}>{STATE_TEXT[v.state]}</span>}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Volume2, VolumeX, Square } from "lucide-react";

/**
 * Browser-only voice for Jackboy chat. Speech-to-text uses the browser's SpeechRecognition
 * (the browser may send audio to its own speech service); Jackboy never records or stores audio.
 * Spoken replies use the browser's speechSynthesis. Both are hidden when unsupported.
 */
type Rec = { start(): void; stop(): void; abort(): void; lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };

export function speechSupport() {
  if (typeof window === "undefined") return { listen: false, speak: false };
  const w = window as any;
  return { listen: Boolean(w.SpeechRecognition || w.webkitSpeechRecognition), speak: "speechSynthesis" in window };
}

export function useChatVoice(onTranscript: (text: string) => void) {
  const [support, setSupport] = useState({ listen: false, speak: false });
  const [listening, setListening] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const rec = useRef<Rec | null>(null);
  useEffect(() => {
    setSupport(speechSupport());
    try { setSpeakReplies(localStorage.getItem("jackboy.chat.speak") === "1"); } catch { /* optional */ }
    return () => { rec.current?.abort(); if ("speechSynthesis" in window) window.speechSynthesis.cancel(); };
  }, []);
  const toggleSpeak = () => {
    const next = !speakReplies;
    setSpeakReplies(next);
    if (!next) stopSpeaking();
    try { localStorage.setItem("jackboy.chat.speak", next ? "1" : "0"); } catch { /* optional */ }
  };
  const stopSpeaking = () => { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); setSpeaking(false); };
  const speak = useCallback((text: string) => {
    if (!speakReplies || !("speechSynthesis" in window) || !text.trim()) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[`*#_>|]/g, "").slice(0, 1500));
    u.onend = () => setSpeaking(false); u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(u);
  }, [speakReplies]);
  const toggleListen = () => {
    if (listening) { rec.current?.stop(); return; }
    const w = window as any; const R = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!R) { setError("Voice input isn't supported in this browser. Type instead."); return; }
    stopSpeaking(); setError("");
    const r: Rec = new R();
    r.lang = navigator.language || "en-US"; r.interimResults = false; r.continuous = false;
    r.onresult = (e) => { const t = Array.from(e.results as ArrayLike<any>).map((x) => x[0]?.transcript ?? "").join(" ").trim(); if (t) onTranscript(t); };
    r.onerror = (e) => setError(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone permission was denied. Allow it in your browser settings, or type instead." : `Voice input stopped (${e.error}). Type instead.`);
    r.onend = () => { setListening(false); rec.current = null; };
    rec.current = r;
    try { r.start(); setListening(true); } catch { setError("Couldn't start the microphone. Type instead."); }
  };
  return { support, listening, speakReplies, speaking, error, toggleListen, toggleSpeak, stopSpeaking, speak };
}

const iconBtn = "inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-electric hover:text-foreground focus-visible:outline-2 focus-visible:outline-electric";

export function VoiceButtons({ v }: { v: ReturnType<typeof useChatVoice> }) {
  return (
    <div className="flex items-center gap-1">
      {v.support.listen && (
        <button type="button" onClick={v.toggleListen} aria-pressed={v.listening} aria-label={v.listening ? "Stop listening" : "Speak your message"} title={v.listening ? "Stop listening" : "Speak — words appear in the box so you can edit before sending"}
          className={`${iconBtn} ${v.listening ? "border-destructive text-destructive" : ""}`}>
          {v.listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </button>
      )}
      {v.support.speak && (
        <button type="button" onClick={v.toggleSpeak} aria-pressed={v.speakReplies} aria-label={v.speakReplies ? "Mute spoken replies" : "Read replies aloud"} title={v.speakReplies ? "Mute spoken replies" : "Read replies aloud"} className={iconBtn}>
          {v.speakReplies ? <Volume2 className="size-4 text-electric" /> : <VolumeX className="size-4" />}
        </button>
      )}
      {v.speaking && <button type="button" onClick={v.stopSpeaking} aria-label="Stop speaking" className={iconBtn}><Square className="size-3" /></button>}
      {v.listening && <span aria-live="polite" className="text-xs text-destructive">Listening…</span>}
    </div>
  );
}

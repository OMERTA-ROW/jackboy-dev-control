import { useEffect, useRef } from "react";
import type { VoiceState } from "@/components/ChatVoice";

export type OrbMode = "idle" | "muted" | "listening" | "thinking" | "speaking" | "error";
const LABEL: Record<OrbMode, string> = { idle: "Ready", muted: "Spoken replies muted", listening: "Listening", thinking: "Thinking / working", speaking: "Speaking", error: "Voice problem" };

/** Orb state comes only from real session events: mic state, transcription, chat request in flight, speech engine. */
export function orbMode(voice: VoiceState, chatBusy: boolean, speakReplies: boolean): OrbMode {
  if (voice === "listening") return "listening";
  if (voice === "speaking") return "speaking";
  if (voice === "processing" || chatBusy) return "thinking";
  if (voice === "error") return "error";
  return speakReplies ? "idle" : "muted";
}

export function VoiceOrb({ mode, level, onTap, size = 72 }: { mode: OrbMode; level: { current: number }; onTap?: () => void; size?: number }) {
  const el = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode !== "listening" && mode !== "speaking") { el.current?.style.setProperty("--orb-level", "0"); return; }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, shown = 0;
    const tick = () => {
      shown += (level.current - shown) * 0.3;
      if (mode === "speaking") level.current *= 0.9; // word-boundary pulses decay
      el.current?.style.setProperty("--orb-level", (reduce ? 0 : shown).toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, level]);
  return (
    <div className="flex flex-col items-center gap-1">
      <button ref={el} type="button" onClick={onTap} data-mode={mode} aria-label={`Jackboy voice: ${LABEL[mode]}. ${mode === "listening" ? "Tap to stop" : "Tap to speak"}`}
        className="jb-orb focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-electric" style={{ width: size }} />
      <span aria-live="polite" data-orb-mode={mode} className="text-[11px] font-medium text-foreground">{LABEL[mode]}</span>
    </div>
  );
}

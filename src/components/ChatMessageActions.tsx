import { useEffect, useRef, useState } from "react";
import { Check, Copy, GitBranch, Code2, Pause, Play, RotateCcw, Share2, Square, ThumbsDown, ThumbsUp, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { speakableText, type Feedback } from "@/lib/chat-scroll";

const iconStyle = "size-9 shrink-0 rounded-full bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-electric focus-visible:ring-electric";

export function ChatMessageActions({ text, assistant, streaming, disabled, time, rating, onRate, onRetry, onBranch }: {
  text: string; assistant: boolean; streaming: boolean; disabled: boolean; time: number | null;
  rating?: Feedback | undefined; onRate: (rating: Feedback) => void;
  onRetry: () => void; onBranch: (mode: "chat" | "code") => void;
}) {
  const [notice, setNotice] = useState("");
  const [speech, setSpeech] = useState<"idle" | "playing" | "paused">("idle");
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(() => () => { if (utterance.current && "speechSynthesis" in window) window.speechSynthesis.cancel(); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setNotice("Copied"); }
    catch { setNotice("Copy unavailable. Select the message text to copy it."); }
  };
  const share = async () => {
    try {
      if (navigator.share) { await navigator.share({ title: "Jackboy conversation", text }); setNotice("Shared"); }
      else { await navigator.clipboard.writeText(text); setNotice("Message copied for sharing"); }
    } catch (e) { if (!(e instanceof Error && e.name === "AbortError")) setNotice("Sharing unavailable. Select the message text to copy it."); }
  };
  const read = () => {
    if (!("speechSynthesis" in window)) { setNotice("Read aloud unavailable in this browser. The transcript remains available."); return; }
    const synth = window.speechSynthesis;
    if (speech === "playing") { synth.pause(); setSpeech("paused"); return; }
    if (speech === "paused") { synth.resume(); setSpeech("playing"); return; }
    const words = speakableText(text, Number.MAX_SAFE_INTEGER);
    if (!words) { setNotice("No readable text in this message."); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(words); utterance.current = u;
    u.onstart = () => setSpeech("playing");
    u.onend = () => { setSpeech("idle"); utterance.current = null; };
    u.onerror = (e) => { setSpeech("idle"); utterance.current = null; if (e.error !== "canceled" && e.error !== "interrupted") setNotice("Playback failed. The transcript remains available."); };
    synth.speak(u);
  };
  const action = (label: string, click: () => void, icon: React.ReactNode, pressed?: boolean) => <Button variant="ghost" size="icon" className={iconStyle} title={label} aria-label={label} aria-pressed={pressed} disabled={streaming} onClick={click}>{icon}</Button>;
  return <div className="mt-1 min-h-16" aria-busy={streaming}>
    <div role="group" aria-label={assistant ? "Reply actions" : "Message actions"} className="flex min-h-9 flex-wrap items-center gap-0.5">
      {action(assistant ? "Copy response" : "Copy message", () => void copy(), notice === "Copied" ? <Check /> : <Copy />)}
      {assistant && <>
        {action("Rate response: thumbs up", () => onRate("up"), <ThumbsUp className={rating === "up" ? "text-electric" : ""} />, rating === "up")}
        {action("Rate response: thumbs down", () => onRate("down"), <ThumbsDown className={rating === "down" ? "text-electric" : ""} />, rating === "down")}
      </>}
      {action(speech === "playing" ? "Pause reading aloud" : speech === "paused" ? "Resume reading aloud" : "Read aloud", read, speech === "playing" ? <Pause /> : speech === "paused" ? <Play /> : <Volume2 />)}
      {speech !== "idle" && action("Stop reading aloud", () => { window.speechSynthesis.cancel(); utterance.current = null; setSpeech("idle"); }, <Square />)}
      {action("Share message", () => void share(), <Share2 />)}
      <Button variant="ghost" size="icon" className={iconStyle} disabled={disabled || streaming} title="Try again — review a new draft first" aria-label="Try again" onClick={onRetry}><RotateCcw /></Button>
      <Button variant="ghost" size="icon" className={iconStyle} disabled={disabled || streaming} title="Branch conversation" aria-label="Branch conversation" onClick={() => onBranch("chat")}><GitBranch /></Button>
      <Button variant="ghost" size="icon" className={iconStyle} disabled={disabled || streaming} title="Branch to CODE — draft only" aria-label="Branch to CODE" onClick={() => onBranch("code")}><Code2 /></Button>
    </div>
    <div className="flex min-h-5 flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
      {time !== null ? <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time> : <span title="This older message did not record a timestamp">Time not recorded</span>}
      <span role="status" aria-live="polite">{notice}</span>
    </div>
  </div>;
}
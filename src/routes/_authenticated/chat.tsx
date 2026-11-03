import { createFileRoute, Link } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Check, Copy, ExternalLink, Hexagon, Square, SquarePen } from "lucide-react";
import { getVoiceChatStatus, synthesizeJackboy } from "@/lib/passport.functions";
import { supabase } from "@/integrations/supabase/client";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useChatVoice, VoiceButtons } from "@/components/ChatVoice";
import { LiveCallBar, StartVoiceButton, useLiveCall, type LiveRow } from "@/components/LiveVoiceCall";
import { CodeTasks, useCodeTasks } from "@/components/CodeTasks";
import { VoiceOrb } from "@/components/VoiceOrb";
import { safeEvidenceUrl, type EvidenceLink } from "@/lib/chat-action";
import { CREDIT_HELP_URL } from "@/lib/work-policy";

export const Route = createFileRoute("/_authenticated/chat")({
  head: () => ({
    meta: [
      { title: "Chat with Jackboy" },
      { name: "description", content: "Talk or type with Jackboy about your projects in one simple conversation." },
      { property: "og:title", content: "Chat with Jackboy" },
      { property: "og:description", content: "A private voice and text conversation with Jackboy." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ChatPage,
});

const STORE = "jackboy.chat.session";
const SUGGESTIONS = ["How are my projects doing?", "What needs my attention?", "What did you work on today?"];

function ChatPage() {
  const code = useCodeTasks();
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: "/api/chat",
    headers: async (): Promise<Record<string, string>> => {
      const { data } = await supabase.auth.getSession();
      return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
    },
  }), []);
  const { messages, sendMessage, setMessages, status, stop } = useChat({ transport, onError: (e) => setError(e.message.includes("402") ? "AI credits are used up. Add credits in Settings → Plans & credits." : e.message) });
  const busy = status === "submitted" || status === "streaming";

  // Session continuity: the conversation survives reloads and navigation within this browser tab only.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return; restored.current = true;
    try { const s = sessionStorage.getItem(STORE); if (s) setMessages(JSON.parse(s) as UIMessage[]); } catch { /* ignore */ }
  }, [setMessages]);
  useEffect(() => { if (restored.current && status === "ready") try { sessionStorage.setItem(STORE, JSON.stringify(messages.slice(-60))); } catch { /* full */ } }, [messages, status]);

  const [fromVoice, setFromVoice] = useState(false);
  const voice = useChatVoice((t) => { setFromVoice(true); setText((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t)); });
  const jackboyVoice = useJackboyVoice();
  const spokenId = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready" || !voice.speakReplies) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant" || spokenId.current === last.id) return;
    spokenId.current = last.id;
    const words = textOf(last);
    if (!words.trim()) return;
    if (jackboyVoice.available) void jackboyVoice.speak(words).catch(() => voice.speak(words));
    else voice.speak(words);
  }, [status, messages, voice.speakReplies, voice.speak, jackboyVoice]);

  const chatContext = () => messages.slice(-12).map((m) => `${m.role === "user" ? "Owner" : "Jackboy"}: ${textOf(m)}`).join("\n").slice(-6000);
  const [liveRows, setLiveRows] = useState<LiveRow[]>([]);
  const addVoiceTranscript = (rows: LiveRow[]) =>
    setMessages((cur) => [...cur, ...rows.filter((r) => r.text.trim()).map((r, i) => ({ id: `voice-${Date.now()}-${i}`, role: r.role, metadata: { voice: true }, parts: [{ type: "text" as const, text: r.text.trim() }] }))]);
  const live = useLiveCall({ chatContext, onLiveRows: setLiveRows, onTranscript: addVoiceTranscript, onCodeCard: code.receive });

  const send = async (t: string) => {
    if (!t.trim() || busy) return;
    setError(null); jackboyVoice.stop(); voice.stopSpeaking();
    if (await code.submit(t)) {
      setMessages(cur => [...cur, { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: t }] }]);
      setText(""); setFromVoice(false); return;
    }
    sendMessage(fromVoice ? { text: t, metadata: { voice: true } } : { text: t });
    setText(""); setFromVoice(false);
  };

  // One page-level scroll: follow new content only when the reader is already near the bottom.
  const end = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const on = () => setAtBottom(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160);
    window.addEventListener("scroll", on, { passive: true }); return () => window.removeEventListener("scroll", on);
  }, []);
  const tail = messages.at(-1);
  useEffect(() => { if (atBottom) end.current?.scrollIntoView({ block: "end" }); }, [messages.length, tail && textOf(tail).length, liveRows, status]);

  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search); const g = q.get("github");
    if (!g) return;
    setBanner(g === "error" ? { ok: false, text: `GitHub authorization didn't complete: ${q.get("reason") ?? "unknown error"}` }
      : { ok: g === "connected", text: `GitHub App installed on ${q.get("account")}. ${q.get("missing") ? `Still missing: ${q.get("missing")}. ` : ""}${q.get("verified") ?? ""}` });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = textarea.current; if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; } }, [text]);
  const newChat = () => { stop(); setMessages([]); try { sessionStorage.removeItem(STORE); } catch { /* ignore */ } };

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-background/90 px-3 py-2 backdrop-blur sm:px-6">
        <Link to="/" aria-label="Back to dashboard" className="inline-flex size-10 items-center justify-center rounded-full hover:bg-muted"><ArrowLeft className="size-5" /></Link>
        <Hexagon className="size-4 text-electric" aria-hidden />
        <h1 className="text-sm font-semibold">Jackboy</h1>
        <button type="button" onClick={newChat} aria-label="New conversation" title="New conversation" className="ml-auto inline-flex size-10 items-center justify-center rounded-full hover:bg-muted"><SquarePen className="size-5" /></button>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-6 select-text" aria-live="polite" aria-busy={busy}>
        {live.live && <div className="flex justify-center py-6"><VoiceOrb mode={live.mode} level={live.level} size={96} onTap={() => live.call.setMuted(!live.call.muted)} actionLabel={live.call.muted ? "Unmute microphone" : "Mute microphone"} /></div>}
        {banner && <p role="status" className={`mb-4 text-sm ${banner.ok ? "text-success" : "text-warning"}`}>{banner.text} <button className="ml-2 underline" onClick={() => setBanner(null)}>Dismiss</button></p>}
        {messages.length === 0 && liveRows.length === 0 ? (
          <div className="flex min-h-[55dvh] flex-col items-center justify-center text-center">
            <Hexagon className="size-10 text-electric" aria-hidden />
            <p className="mt-4 text-2xl font-semibold text-silver">What are we working on?</p>
            <p className="mt-2 text-sm text-muted-foreground">For development, say or type “CODE Project name: describe the change”.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-border px-4 py-2 text-sm hover:border-electric">{s}</button>)}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-6 pt-4">
            {messages.map((m) => <Bubble key={m.id} m={m} streaming={busy && m === tail && m.role === "assistant"} />)}
            {liveRows.map((r, i) => <li key={`live-${i}`} className={r.role === "user" ? "self-end max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 text-[15px]" : "text-[15px] leading-relaxed"}>{r.text}</li>)}
            {status === "submitted" && <li><Shimmer className="text-sm">Thinking…</Shimmer></li>}
          </ol>
        )}
        <div ref={end} />
        <CodeTasks tasks={code} />
      </main>

      <footer className="sticky bottom-0 bg-gradient-to-t from-background via-background to-background/0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <LiveCallBar v={live} />
          {(error || voice.error || jackboyVoice.error) && <p role="alert" className="mb-2 px-2 text-xs text-destructive">{error ?? voice.error ?? jackboyVoice.error}</p>}
          {error && /credits|402/i.test(error) && <a href={CREDIT_HELP_URL} target="_blank" rel="noopener noreferrer" className="block px-2 text-xs text-primary underline">Paused: out of credits — open credit setup instructions</a>}
          <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex items-end gap-2 rounded-3xl border border-border bg-card px-3 py-2 focus-within:border-electric">
            <label htmlFor="jb-msg" className="sr-only">Message Jackboy. For development say CODE, the exact project name, a colon, then the task.</label>
            <textarea id="jb-msg" ref={textarea} rows={1} value={text} placeholder="Message Jackboy"
              onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) setFromVoice(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }}
              className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-muted-foreground" />
            <VoiceButtons v={voice} />
            {busy ? <button type="button" onClick={stop} aria-label="Stop reply" className="inline-flex size-9 items-center justify-center rounded-full bg-foreground text-background"><Square className="size-3.5" /></button>
              : text.trim() ? <button type="submit" aria-label="Send message" className="inline-flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground"><ArrowUp className="size-4" /></button>
              : !live.live && <StartVoiceButton v={live} />}
          </form>
        </div>
      </footer>
    </div>
  );
}

const textOf = (m: UIMessage) => m.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" ");

function Bubble({ m, streaming }: { m: UIMessage; streaming: boolean }) {
  if (m.role === "user") return <li className="self-end max-w-[85%] whitespace-pre-wrap rounded-3xl bg-muted px-4 py-2.5 text-[15px]">{textOf(m).replace(/^🎙\s*/, "")}</li>;
  const words = textOf(m);
  return (
    <li className="group text-[15px] leading-relaxed">
      {m.parts.map((part, i) => {
        if (part.type === "text") return <MessageResponse key={i}>{part.text}</MessageResponse>;
        if (isToolUIPart(part)) return <ToolLine key={i} name={part.type === "dynamic-tool" ? part.toolName : part.type.slice(5)} state={part.state} output={part.output} errorText={part.errorText} />;
        return null;
      })}
      {!streaming && words.trim() && <CopyButton text={words} />}
    </li>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })} className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs text-muted-foreground opacity-70 hover:text-foreground hover:opacity-100" aria-label="Copy reply">{done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</button>;
}

/** Plays typed replies in the ElevenLabs "Jackboy" voice when configured; stoppable so the owner can interrupt. */
function useJackboyVoice() {
  const status = useServerFn(getVoiceChatStatus);
  const synth = useServerFn(synthesizeJackboy);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { status().then((s) => setAvailable(s.voiceAvailable)).catch(() => setAvailable(false)); }, [status]);
  const speak = useCallback(async (words: string) => {
    setError(null);
    try {
      const r = await synth({ data: { text: words.replace(/[#*`_>|]/g, "").slice(0, 900) } });
      audio.current?.pause();
      const a = new Audio(`data:${r.mimeType};base64,${r.audioBase64}`);
      audio.current = a;
      await a.play();
    } catch (e) { setError(e instanceof Error ? e.message : "Jackboy's voice failed; the reply is still here as text."); throw e; }
  }, [synth]);
  const stop = useCallback(() => { audio.current?.pause(); audio.current = null; }, []);
  return useMemo(() => ({ available, error, speak, stop }), [available, error, speak, stop]);
}

type AuthLink = { label: string; url: string; primary?: boolean };
type Authorization = { provider: string; repo: string | null; state: string; missing: string[]; links: AuthLink[]; detail: string };
const TOOL_WORDS: Record<string, string> = { authorizationHelp: "Finding the right approval link", get_status: "Checking your projects", scan_site: "Scanning the site", read_file: "Reading a file", list_files: "Looking through files", write_file: "Writing a change", open_pr: "Opening a draft pull request" };
const human = (n: string) => TOOL_WORDS[n] ?? n.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Real tool calls appear as one quiet line while running; finished ones vanish unless they failed or need an approval link. */
function ToolLine({ name, state, output, errorText }: { name: string; state: string; output: unknown; errorText?: string | undefined }) {
  const running = state === "input-streaming" || state === "input-available";
  const failed = state === "output-error" || state === "output-denied";
  const auth = (output as { authorizations?: Authorization[] } | null)?.authorizations?.find((a) => a.state !== "authorized");
  const value = output as { blocked?: boolean; reason?: string; evidence?: EvidenceLink[] } | null;
  const evidence = value?.evidence?.filter((l) => safeEvidenceUrl(l.url)) ?? [];
  if (running) return <Shimmer className="my-1 block text-sm">{`${human(name)}…`}</Shimmer>;
  if (auth) {
    const link = auth.links.find((l) => l.primary && l.url.startsWith("https://github.com/")) ?? auth.links.find((l) => l.url.startsWith("https://github.com/"));
    return <p className="my-2 text-sm">{auth.provider} needs your approval{auth.repo ? ` for ${auth.repo}` : ""}.{link && <> <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-electric underline"><ExternalLink className="size-3.5" />Approve on {auth.provider}</a></>}</p>;
  }
  if (state === "approval-requested") return <p className="my-1 text-sm text-warning">{human(name)} is waiting for your approval.</p>;
  if (failed) return <p role="alert" className="my-1 text-sm text-destructive">{human(name)} didn't work{errorText ? `: ${errorText.slice(0, 200)}` : "."}</p>;
  if (value?.blocked || evidence.length) return <div className="my-2 text-sm">{value?.blocked && <p role="alert" className="text-destructive">Blocked: {value.reason}</p>}<div className="flex flex-wrap gap-3">{evidence.map((l) => <a key={l.url} href={l.url} className="inline-flex items-center gap-1 text-xs text-primary underline"><ExternalLink className="size-3.5" />{l.label}</a>)}</div></div>;
  return null;
}


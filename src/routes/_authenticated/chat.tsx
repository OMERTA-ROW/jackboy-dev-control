import { createFileRoute } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hexagon, ChevronDown, ChevronUp, Loader2, CheckCircle2, AlertCircle, Copy, Check, ExternalLink, PanelRight } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { getVoiceChatStatus, synthesizeJackboy } from "@/lib/passport.functions";
import { supabase } from "@/integrations/supabase/client";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { getAutopilot } from "@/lib/autopilot.functions";
import { useChatVoice, VoiceButtons } from "@/components/ChatVoice";
import { AgentStatusPanel } from "@/components/AgentStatusPanel";
import { LiveVoiceCall } from "@/components/LiveVoiceCall";

export const Route = createFileRoute("/_authenticated/chat")({
  head: () => ({
    meta: [
      { title: "Chat with Jackboy" },
      { name: "description", content: "Talk to Jackboy about your projects, scans and updates, and give commands." },
      { property: "og:title", content: "Chat with Jackboy" },
      { property: "og:description", content: "Owner chat with Jackboy: status, scans, fixes and Autopilot commands." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ChatPage,
});

const SUGGESTIONS = ["What's the status of my projects?", "Show the latest scan results", "What updates are queued?"];

function ChatPage() {
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
  const addVoiceTranscript = (rows: { role: "user" | "assistant"; text: string }[]) =>
    setMessages((cur) => [...cur, ...rows.filter((r) => r.text.trim()).map((r, i) => ({ id: `voice-${Date.now()}-${i}`, role: r.role, parts: [{ type: "text" as const, text: r.role === "user" ? `🎙 ${r.text.trim()}` : r.text.trim() }] }))]);
  const [orbOpen, setOrbOpen] = useState(true);
  const drag = useRef<number | null>(null);
  const dragged = useRef(false);
  const swallow = () => { dragged.current = true; setTimeout(() => { dragged.current = false; }, 400); };
  const send = (t: string) => { if (!t.trim() || busy) return; setError(null); setOrbOpen(false); sendMessage(fromVoice ? { text: t, metadata: { voice: true } } : { text: t }); setText(""); setFromVoice(false); };
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search); const g = q.get("github");
    if (!g) return;
    setOrbOpen(false);
    setBanner(g === "error" ? { ok: false, text: `GitHub authorization didn't complete: ${q.get("reason") ?? "unknown error"}` }
      : { ok: g === "connected", text: `GitHub App installed on ${q.get("account")}. ${q.get("missing") ? `Still missing: ${q.get("missing")}. ` : ""}${q.get("verified") ?? ""}` });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const dragProps = {
    onPointerDown: (e: React.PointerEvent) => { dragged.current = false; drag.current = e.clientY; },
    onPointerMove: (e: React.PointerEvent) => {
      if (drag.current === null) return;
      const dy = e.clientY - drag.current;
      if (orbOpen && dy > 48) { drag.current = null; swallow(); setOrbOpen(false); }
      else if (!orbOpen && dy < -40) { drag.current = null; swallow(); setOrbOpen(true); }
    },
    onPointerUp: () => { drag.current = null; },
    onClickCapture: (e: React.MouseEvent) => { if (dragged.current) { dragged.current = false; e.stopPropagation(); e.preventDefault(); } },
  };

  return (
    <section className="panel relative -mx-2 flex h-[calc(100dvh-6.5rem)] min-h-[30rem] flex-col overflow-hidden sm:mx-0">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Hexagon className="size-4 text-electric" aria-hidden />
        <h1 className="text-sm font-semibold">Jackboy</h1>
        <span className="text-xs text-muted-foreground">{busy ? "working…" : "online"}</span>
        <Sheet>
          <SheetTrigger className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-md border border-border px-3 text-xs hover:border-electric"><PanelRight className="size-4" />Status & activity</SheetTrigger>
          <SheetContent className="w-full overflow-y-auto sm:max-w-md"><SheetHeader><SheetTitle>Jackboy status</SheetTitle></SheetHeader><div className="mt-4 flex flex-col gap-4"><AgentStatusPanel /><ActivityFeed refreshKey={messages.length + (busy ? 0 : 1)} /></div></SheetContent>
        </Sheet>
      </header>
      {banner && <p role="status" className={`border-b px-4 py-2 text-xs ${banner.ok ? "border-success/40 text-success" : "border-warning/40 text-warning"}`}>{banner.text} <button className="ml-2 underline" onClick={() => setBanner(null)}>Dismiss</button></p>}
      {/* The conversation stays mounted (never lost); the big orb simply covers it until docked. */}
      <Conversation className={orbOpen ? "hidden" : "flex-1"}>
        <ConversationContent className="mx-auto w-full max-w-3xl select-text">
          {messages.length === 0 ? (
            <ConversationEmptyState icon={<Hexagon className="size-8 text-electric" />} title="Right, what are we fixing today?" description="Ask me anything about your projects. I only report what I can actually see — no make-believe.">
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-border px-3 py-1 text-xs hover:border-electric">{s}</button>)}
              </div>
            </ConversationEmptyState>
          ) : messages.map((m) => (
            <Message key={m.id} from={m.role}>
              <MessageContent className={m.role === "user" ? "bg-primary text-primary-foreground" : "bg-transparent"}>
                {m.parts.map((part, i) => {
                  if (part.type === "text") return <MessageResponse key={i}>{part.text}</MessageResponse>;
                  if (isToolUIPart(part)) return <TaskUpdate key={i} name={part.type === "dynamic-tool" ? part.toolName : part.type.slice(5)} state={part.state} input={part.input} output={part.output} errorText={part.errorText} />;
                  return null;
                })}
                {m.role === "assistant" && textOf(m).trim() && <CopyButton text={textOf(m)} />}
              </MessageContent>
            </Message>
          ))}
          {status === "submitted" && <Shimmer className="text-sm">Jackboy is thinking…</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div
        className={orbOpen ? "flex flex-1 touch-none select-none flex-col items-center justify-center bg-background" : "flex touch-none items-center gap-1 border-t border-border pr-2 [&>div:nth-child(2)]:flex-1"}
        {...dragProps}
        onWheel={orbOpen ? (e) => { if (e.deltaY > 12) setOrbOpen(false); } : undefined}
        onKeyDown={(e) => { if (orbOpen && (e.key === "ArrowDown" || e.key === "Escape")) setOrbOpen(false); else if (!orbOpen && e.key === "ArrowUp" && e.altKey) setOrbOpen(true); }}
      >
        {!orbOpen && <span aria-hidden className="ml-2 h-8 w-1 shrink-0 cursor-grab rounded-full bg-border" title="Drag up to enlarge" />}
        <LiveVoiceCall chatContext={chatContext} onTranscript={addVoiceTranscript} variant={orbOpen ? "expanded" : "docked"} />
        {orbOpen
          ? <button type="button" onClick={() => setOrbOpen(false)} className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-full border border-border bg-background/80 px-4 text-xs text-silver hover:border-electric" aria-label="Dock the voice orb and show the conversation"><ChevronDown className="h-4 w-4" />Drag down to see the chat{messages.length ? ` (${messages.length})` : ""}</button>
          : <button type="button" onClick={() => setOrbOpen(true)} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-[11px] text-silver hover:border-electric" aria-label="Enlarge the voice orb"><ChevronUp className="h-3.5 w-3.5" />Enlarge</button>}
      </div>
      {voice.error && <p role="alert" className="border-t border-destructive/40 px-4 py-2 text-xs text-destructive">{voice.error}</p>}
      {jackboyVoice.error && <p role="alert" className="border-t border-warning/40 px-4 py-2 text-xs text-warning">{jackboyVoice.error}</p>}
      {error && <p role="alert" className="border-t border-destructive/40 px-4 py-2 text-xs text-destructive">{error}</p>}
      <div className="border-t border-border p-3">
        <div className="mx-auto max-w-3xl">
          <PromptInput onSubmit={(msg) => send(msg.text)}>
            <PromptInputBody>
              <PromptInputTextarea value={text} onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) setFromVoice(false); }} placeholder="Message Jackboy… or tap the mic" />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools><VoiceButtons v={voice} />{voice.speakReplies && <span className="text-[11px] text-muted-foreground">{jackboyVoice.available ? "Replies in Jackboy's voice" : "Jackboy voice unavailable — using device voice"}</span>}</PromptInputTools>
              <PromptInputSubmit status={status} onStop={stop} disabled={!busy && !text.trim()} />
            </PromptInputFooter>
          </PromptInput>
          <p className="mt-1 text-[11px] text-muted-foreground">Mic listens only after you tap it; audio is never saved. Spoken words land in the box to edit, and voice-requested changes need a “confirm”.</p>
        </div>
      </div>
    </section>
  );
}

const textOf = (m: UIMessage) => m.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" ");

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })} className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" aria-label="Copy reply">{done ? <Check className="size-3" /> : <Copy className="size-3" />}{done ? "Copied" : "Copy"}</button>;
}

/** Speaks replies with the original ElevenLabs "Jackboy" voice (server-side key) when it is configured. */
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
  return useMemo(() => ({ available, error, speak }), [available, error, speak]);
}

type AuthLink = { label: string; url: string; primary?: boolean };
type Authorization = { provider: string; repo: string | null; state: string; missing: string[]; automatic: string[]; ownerMust: string[]; links: AuthLink[]; detail: string; lastError: string | null };

/** Real authorization destinations returned by the server; nothing here is invented client-side. */
function AuthCard({ a }: { a: Authorization }) {
  const primary = a.links.find((l) => l.primary) ?? a.links[0];
  const safe = (u: string) => u.startsWith("https://github.com/");
  return (
    <div className="my-2 rounded-lg border border-electric/50 bg-card/60 p-3 text-xs">
      <p className="font-semibold">{a.provider} access {a.state === "authorized" ? "is in place" : `needed${a.repo ? ` for ${a.repo}` : ""}`}</p>
      <p className="mt-1 text-muted-foreground">{a.detail}</p>
      {a.lastError && <p className="mt-1 text-destructive">Last GitHub answer: {a.lastError}</p>}
      {a.missing.length > 0 && <><p className="mt-2 font-medium">Missing permissions</p><ul className="list-disc pl-4">{a.missing.map((m) => <li key={m}>{m}</li>)}</ul></>}
      {a.ownerMust.length > 0 && <><p className="mt-2 font-medium">You approve</p><ul className="list-disc pl-4">{a.ownerMust.map((m) => <li key={m}>{m}</li>)}</ul></>}
      {a.automatic.length > 0 && <><p className="mt-2 font-medium">I handle automatically after that</p><ul className="list-disc pl-4">{a.automatic.map((m) => <li key={m}>{m}</li>)}</ul></>}
      {primary && safe(primary.url) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a href={primary.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-md bg-primary px-3 font-medium text-primary-foreground"><ExternalLink className="size-3.5" />Take me there</a>
          {a.links.filter((l) => safe(l.url)).map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="break-all text-electric underline">{l.label}</a>)}
        </div>
      )}
    </div>
  );
}

const TOOL_WORDS: Record<string, string> = { authorizationHelp: "Finding the right approval link", get_status: "Checking project status", scan_site: "Scanning the site", read_file: "Reading a file", list_files: "Looking through files", write_file: "Writing a change", open_pr: "Opening a draft pull request" };
const human = (n: string) => TOOL_WORDS[n] ?? n.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** One conversational line per real tool call: live state, result or error, with details on request. */
function TaskUpdate({ name, state, input, output, errorText }: { name: string; state: string; input: unknown; output: unknown; errorText?: string | undefined }) {
  const running = state === "input-streaming" || state === "input-available";
  const failed = state === "output-error" || state === "output-denied";
  const waiting = state === "approval-requested";
  const auths = (output as { authorizations?: Authorization[] } | null)?.authorizations;
  if (auths?.length && !running) return <>{auths.map((a, i) => <AuthCard key={i} a={a} />)}</>;
  return (
    <details className="group my-1 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-electric">
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-electric" /> : failed ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : <CheckCircle2 className={`h-3.5 w-3.5 ${waiting ? "text-warning" : "text-success"}`} />}
        <span>{human(name)}{running ? "…" : waiting ? " — needs your approval" : failed ? " — failed" : ""}</span>
        <span className="ml-auto text-muted-foreground group-open:hidden">details</span>
      </summary>
      {failed && errorText && <p role="alert" className="mt-2 text-destructive">{errorText}</p>}
      {failed && /403|not accessible|permission/i.test(errorText ?? "") && <p className="mt-1 text-muted-foreground">That's an access problem, not a dead end — ask me “how do I fix access?” and I'll bring the GitHub link.</p>}
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[11px] text-muted-foreground">{JSON.stringify({ asked: input, result: output }, null, 2)?.slice(0, 4000)}</pre>
    </details>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "autopilot.scan": "Scanned site", "autopilot.fix_written": "Wrote a fix", "autopilot.connect": "Connected project",
  "autopilot.shipped": "Shipped update", "autopilot.release": "Started rollout", "autopilot.master": "Master Autopilot changed",
  "autopilot.project": "Project Autopilot changed", "chat.command": "Chat command", "updates.pr_open": "Opened pull request",
  "updates.merged": "Merged update", "updates.generate": "Wrote update",
};

export function ActivityFeed({ refreshKey = 0 }: { refreshKey?: number }) {
  const load = useServerFn(getAutopilot);
  const [items, setItems] = useState<Awaited<ReturnType<typeof getAutopilot>>["activity"] | null>(null);
  const refresh = useCallback(() => load().then((r) => setItems(r.activity)).catch(() => setItems([])), [load]);
  useEffect(() => { refresh(); }, [refresh, refreshKey]);
  return (
    <aside className="panel max-h-[70vh] overflow-y-auto p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-silver">Jackboy's activity</h2>
      {!items ? <p className="text-xs text-muted-foreground">Loading…</p> : items.length === 0 ? <p className="text-xs text-muted-foreground">No actions yet.</p> : (
        <ol className="space-y-2 text-xs">
          {items.map((a) => {
            const d = a.detail;
            return (
              <li key={a.id} className="border-l-2 border-border pl-2">
                <div className={a.outcome === "error" ? "text-destructive" : a.outcome === "ok" ? "" : "text-electric"}>{ACTION_LABEL[a.action] ?? a.action}{d.on !== undefined ? ` → ${d.on ? "on" : "off"}` : ""}</div>
                <div className="text-muted-foreground">{[d.name, d.title, d.command, d.error].filter(Boolean).join(" · ")}</div>
                <time className="text-muted-foreground/70">{new Date(a.at).toLocaleString()}</time>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hexagon, ChevronDown, ChevronUp, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
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
  const spokenId = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready") return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant" || spokenId.current === last.id) return;
    spokenId.current = last.id;
    voice.speak(last.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" "));
  }, [status, messages, voice.speak]);
  const textOf = (m: UIMessage) => m.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" ");
  const chatContext = () => messages.slice(-12).map((m) => `${m.role === "user" ? "Owner" : "Jackboy"}: ${textOf(m)}`).join("\n").slice(-6000);
  const addVoiceTranscript = (rows: { role: "user" | "assistant"; text: string }[]) =>
    setMessages((cur) => [...cur, ...rows.filter((r) => r.text.trim()).map((r, i) => ({ id: `voice-${Date.now()}-${i}`, role: r.role, parts: [{ type: "text" as const, text: r.role === "user" ? `🎙 ${r.text.trim()}` : r.text.trim() }] }))]);
  const [orbOpen, setOrbOpen] = useState(true);
  const drag = useRef<number | null>(null);
  const dock = () => setOrbOpen(false);
  const send = (t: string) => { if (!t.trim() || busy) return; setError(null); sendMessage(fromVoice ? { text: t, metadata: { voice: true } } : { text: t }); setText(""); setFromVoice(false); };

  return (
    <>
      <PageHeader title="Chat with Jackboy" subtitle="Ask about projects, scans and updates, or give commands like “scan site X”, “fix issue Y”, “pause autopilot on Z”." />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section className="panel relative flex h-[calc(100dvh-11rem)] min-h-[32rem] flex-col overflow-hidden lg:h-[72vh]">
          <Conversation className="flex-1">
            <ConversationContent>
              {messages.length === 0 ? (
                <ConversationEmptyState icon={<Hexagon className="size-8 text-electric" />} title="Jackboy is ready" description="He only reports what he can see in your projects — nothing is made up.">
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
                  </MessageContent>
                </Message>
              ))}
              {status === "submitted" && <Shimmer className="text-sm">Jackboy is thinking…</Shimmer>}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
          {voice.error && <p role="alert" className="border-t border-destructive/40 px-4 py-2 text-xs text-destructive">{voice.error}</p>}
          {error && <p role="alert" className="border-t border-destructive/40 px-4 py-2 text-xs text-destructive">{error}</p>}
          <div
            className={orbOpen ? "absolute inset-x-0 top-0 bottom-[9.5rem] z-10 flex touch-none flex-col items-center justify-center bg-background/75 backdrop-blur-sm" : "border-t border-border"}
            onPointerDown={orbOpen ? (e) => { if ((e.target as HTMLElement).closest("button")) return; drag.current = e.clientY; } : undefined}
            onPointerMove={orbOpen ? (e) => { if (drag.current !== null && e.clientY - drag.current > 48) { drag.current = null; dock(); } } : undefined}
            onPointerUp={() => { drag.current = null; }}
            onWheel={orbOpen ? (e) => { if (Math.abs(e.deltaY) > 12) dock(); } : undefined}
            onKeyDown={(e) => { if (orbOpen && (e.key === "ArrowDown" || e.key === "Escape")) dock(); else if (!orbOpen && e.key === "ArrowUp" && e.altKey) setOrbOpen(true); }}
          >
            <LiveVoiceCall chatContext={chatContext} onTranscript={addVoiceTranscript} variant={orbOpen ? "expanded" : "docked"} />
            {orbOpen
              ? <button type="button" onClick={dock} className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-full border border-border bg-background/80 px-4 text-xs text-silver hover:border-electric" aria-label="Dock voice orb above the message box and show the conversation"><ChevronDown className="h-4 w-4" />Drag down or tap to show chat</button>
              : <button type="button" onClick={() => setOrbOpen(true)} className="absolute right-3 top-2 inline-flex min-h-9 items-center gap-1 rounded-full border border-border px-3 text-[11px] text-silver hover:border-electric" aria-label="Expand voice orb"><ChevronUp className="h-3.5 w-3.5" />Expand</button>}
          </div>
          <div className="relative border-t border-border p-3">
            <PromptInput onSubmit={(msg) => send(msg.text)}>
              <PromptInputBody>
                <PromptInputTextarea autoFocus value={text} onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) setFromVoice(false); }} placeholder="Message Jackboy…" />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools><VoiceButtons v={voice} /></PromptInputTools>
                <PromptInputSubmit status={status} onStop={stop} disabled={!busy && !text.trim()} />
              </PromptInputFooter>
            </PromptInput>
            {(voice.support.listen !== "none" || voice.support.speak) && <p className="mt-1 text-[11px] text-muted-foreground">The mic listens only after you tap it. Speech is turned into text by your browser, or sent once to Jackboy's transcription service on browsers without it; audio is never saved. Spoken words appear in the box to edit before sending, and changes asked for by voice need you to reply “confirm”.</p>}
          </div>
        </section>
        <div className="flex flex-col gap-4 lg:max-h-[72vh] lg:overflow-y-auto"><AgentStatusPanel /><ActivityFeed refreshKey={messages.length + (busy ? 0 : 1)} /></div>
      </div>
    </>
  );
}

const TOOL_WORDS: Record<string, string> = { get_status: "Checking project status", scan_site: "Scanning the site", read_file: "Reading a file", list_files: "Looking through files", write_file: "Writing a change", open_pr: "Opening a draft pull request" };
const human = (n: string) => TOOL_WORDS[n] ?? n.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** One conversational line per real tool call: live state, result or error, with details on request. */
function TaskUpdate({ name, state, input, output, errorText }: { name: string; state: string; input: unknown; output: unknown; errorText?: string | undefined }) {
  const running = state === "input-streaming" || state === "input-available";
  const failed = state === "output-error" || state === "output-denied";
  const waiting = state === "approval-requested";
  return (
    <details className="group my-1 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-electric">
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-electric" /> : failed ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : <CheckCircle2 className={`h-3.5 w-3.5 ${waiting ? "text-warning" : "text-success"}`} />}
        <span>{human(name)}{running ? "…" : waiting ? " — needs your approval" : failed ? " — failed" : ""}</span>
        <span className="ml-auto text-muted-foreground group-open:hidden">details</span>
      </summary>
      {failed && errorText && <p role="alert" className="mt-2 text-destructive">{errorText}</p>}
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

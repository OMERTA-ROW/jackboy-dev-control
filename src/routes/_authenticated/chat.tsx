import { createFileRoute } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hexagon } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "@/components/ai-elements/prompt-input";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { getAutopilot } from "@/lib/autopilot.functions";
import { useChatVoice, VoiceButtons } from "@/components/ChatVoice";
import { AgentStatusPanel } from "@/components/AgentStatusPanel";

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
  const { messages, sendMessage, status, stop } = useChat({ transport, onError: (e) => setError(e.message.includes("402") ? "AI credits are used up. Add credits in Settings → Plans & credits." : e.message) });
  const busy = status === "submitted" || status === "streaming";
  const voice = useChatVoice((t) => setText((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t)));
  const spokenId = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready") return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant" || spokenId.current === last.id) return;
    spokenId.current = last.id;
    voice.speak(last.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" "));
  }, [status, messages, voice.speak]);
  const send = (t: string) => { if (!t.trim() || busy) return; setError(null); sendMessage({ text: t }); setText(""); };

  return (
    <>
      <PageHeader title="Chat with Jackboy" subtitle="Ask about projects, scans and updates, or give commands like “scan site X”, “fix issue Y”, “pause autopilot on Z”." />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section className="panel flex h-[70vh] flex-col overflow-hidden">
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
                      if (isToolUIPart(part)) return (
                        <Tool key={i} defaultOpen={false}>
                          {part.type === "dynamic-tool" ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} /> : <ToolHeader type={part.type} state={part.state} />}
                          <ToolContent><ToolInput input={part.input} /><ToolOutput output={part.output} errorText={part.errorText} /></ToolContent>
                        </Tool>
                      );
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
          <div className="border-t border-border p-3">
            <PromptInput onSubmit={(msg) => send(msg.text)}>
              <PromptInputBody>
                <PromptInputTextarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Message Jackboy…" />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools><VoiceButtons v={voice} /></PromptInputTools>
                <PromptInputSubmit status={status} onStop={stop} disabled={!busy && !text.trim()} />
              </PromptInputFooter>
            </PromptInput>
            {(voice.support.listen || voice.support.speak) && <p className="mt-1 text-[11px] text-muted-foreground">Voice uses your browser's speech features; your browser may send speech to its own service. Jackboy doesn't record or save audio. Spoken words appear in the box so you can edit before sending.</p>}
          </div>
        </section>
        <div className="flex flex-col gap-4"><AgentStatusPanel /><ActivityFeed refreshKey={messages.length + (busy ? 0 : 1)} /></div>
      </div>
    </>
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

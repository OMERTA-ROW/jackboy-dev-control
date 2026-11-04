import { createFileRoute, Link, type ErrorComponentProps } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { useServerFn } from "@tanstack/react-start";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Check, ChevronDown, ChevronUp, Copy, ExternalLink, Hexagon, History, SlidersHorizontal, Square, SquarePen, Trash2 } from "lucide-react";
import { getVoiceChatStatus, synthesizeJackboy } from "@/lib/passport.functions";
import { supabase } from "@/integrations/supabase/client";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useChatVoice, VoiceButtons } from "@/components/ChatVoice";
import { LiveCallBar, StartVoiceButton, useLiveCall, type LiveRow } from "@/components/LiveVoiceCall";
import { CodeTasks, useCodeTasks } from "@/components/CodeTasks";
import { VoiceOrb } from "@/components/VoiceOrb";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { safeEvidenceUrl, type EvidenceLink } from "@/lib/chat-action";
import { CREDIT_HELP_URL } from "@/lib/work-policy";
import { getProjectHub } from "@/lib/project-hub.functions";
import { ACTIVITY_LABEL, deriveActivity } from "@/lib/chat-status";
import { loadConversations, saveConversations, titleFrom, upsertConversation, type ChatMode, type Conversation, type StoredMessage } from "@/lib/chat-history";

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
  errorComponent: ChatError,
});

/** Page-level recovery: saved conversations live in this browser, so reloading the chat keeps them. */
function ChatError({ error, reset }: ErrorComponentProps) {
  return (
    <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      <p className="text-lg font-semibold text-silver">The chat hit a problem</p>
      <p className="max-w-sm text-sm text-muted-foreground">Your saved conversations are safe. {(error instanceof Error ? error.message : "").slice(0, 160)}</p>
      <div className="flex gap-2">
        <button type="button" onClick={reset} className="rounded-full border border-border px-4 py-2 text-sm hover:border-silver">Try again</button>
        <button type="button" onClick={() => window.location.reload()} className="rounded-full border border-border px-4 py-2 text-sm hover:border-silver">Reload chat</button>
      </div>
    </div>
  );
}

/** Keeps one unrenderable message (e.g. odd markdown mid-stream) from taking down the whole page. */
class MessageBoundary extends Component<{ fallback: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidUpdate(prev: { fallback: string }) { if (this.state.failed && prev.fallback !== this.props.fallback) this.setState({ failed: false }); }
  override render() {
    return this.state.failed ? <li className="min-w-0 whitespace-pre-wrap text-[15px] leading-relaxed [overflow-wrap:anywhere]">{this.props.fallback}</li> : this.props.children;
  }
}

const SUGGESTIONS = ["How are my projects doing?", "What needs my attention?", "What did you work on today?"];
const KEEP_VISIBLE = 2;

function ChatPage() {
  const code = useCodeTasks();
  // Chat and CODE are separate modes with separate conversations. CODE only builds the existing
  // "CODE Project: task" request; the backend admission gate and approval cards decide everything.
  const [view, setView] = useState<ChatMode>("chat");
  const [userId, setUserId] = useState<string | null>(null);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>(() => crypto.randomUUID());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const hub = useServerFn(getProjectHub);
  const [repos, setRepos] = useState<{ id: string; name: string }[] | null>(null);
  const [repoErr, setRepoErr] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  useEffect(() => {
    if (view !== "code" || repos) return;
    // Only project names reach the browser view; repository paths stay in Projects.
    hub().then((h) => { const list = h.projects.filter((p) => p.github_repo).map((p) => ({ id: p.id, name: p.name })); setRepos(list); if (list[0]) setTarget((t) => t || list[0]!.name); })
      .catch((e) => setRepoErr((e as Error).message));
  }, [view, repos, hub]);
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

  // History is keyed by the signed-in account; switching accounts reloads a different list.
  useEffect(() => {
    const load = (uid: string | null) => {
      setUserId(uid);
      const list = uid ? loadConversations(localStorage, uid) : [];
      setConvos(list);
      let mode: ChatMode = "chat";
      try { if (sessionStorage.getItem("jackboy.chat.view") === "code") mode = "code"; } catch { /* ignore */ }
      setView(mode);
      const latest = list.find((c) => c.mode === mode);
      setActiveId(latest?.id ?? crypto.randomUUID());
      setMessages((latest?.messages ?? []) as UIMessage[]);
    };
    void supabase.auth.getSession().then(({ data }) => load(data.session?.user.id ?? null));
    const { data } = supabase.auth.onAuthStateChange((e, s) => { if (e === "SIGNED_IN" || e === "SIGNED_OUT") load(s?.user.id ?? null); });
    return () => data.subscription.unsubscribe();
  }, [setMessages]);
  useEffect(() => {
    // Save after the user turn is submitted and after each reply, not on every streamed token.
    if (!userId || status === "streaming" || !messages.length) return;
    setConvos((list) => {
      const next = upsertConversation(list, { id: activeId, mode: view, title: titleFrom(messages as StoredMessage[]), updatedAt: Date.now(), messages: messages as StoredMessage[] });
      saveConversations(localStorage, userId, next);
      return next;
    });
  }, [messages, status, userId, activeId, view]);

  const openConversation = (c: Conversation | null, mode: ChatMode = c?.mode ?? view) => {
    stop(); setError(null); setCollapsed(false);
    setView(mode); try { sessionStorage.setItem("jackboy.chat.view", mode); } catch { /* ignore */ }
    setActiveId(c?.id ?? crypto.randomUUID());
    setMessages((c?.messages ?? []) as UIMessage[]);
    setHistoryOpen(false);
  };
  const switchView = (v: ChatMode) => { if (v !== view) openConversation(convos.find((c) => c.mode === v) ?? null, v); };
  const deleteConversation = (id: string) => {
    if (!userId) return;
    const next = convos.filter((c) => c.id !== id);
    setConvos(next); saveConversations(localStorage, userId, next);
    if (id === activeId) openConversation(null);
  };

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
    setMessages((cur) => [...cur, ...rows.filter((r) => r.text.trim() || r.evidence?.length).map((r, i) => ({ id: `voice-${Date.now()}-${i}`, role: r.role, metadata: { voice: true, evidence: r.evidence ?? [] }, parts: [{ type: "text" as const, text: r.text.trim() }] }))]);
  const live = useLiveCall({ chatContext, onLiveRows: setLiveRows, onTranscript: addVoiceTranscript, onCodeCard: code.receive });

  const addUser = (t: string) => setMessages((cur) => [...cur, { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: t }] }]);
  const send = async (t: string) => {
    if (!t.trim() || busy) return;
    setError(null); jackboyVoice.stop(); voice.stopSpeaking();
    if (view === "code") {
      // Allow/Deny phrases still go to the pending card; anything else becomes a request for the selected project.
      const direct = /^\s*(CODE\s+[^:\n]+:|(allow|deny)\s+CODE\s)/i.test(t);
      if (!direct && !target) { setError("Pick a project first."); setToolsOpen(true); return; }
      if (await code.submit(direct ? t : `CODE ${target}: ${t.trim()}`)) { addUser(direct ? t : `${target}: ${t.trim()}`); setText(""); setFromVoice(false); }
      return;
    }
    if (await code.submit(t)) { addUser(t); setText(""); setFromVoice(false); return; }
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
  useEffect(() => { if (!atBottom) return; const id = requestAnimationFrame(() => end.current?.scrollIntoView({ block: "end" })); return () => cancelAnimationFrame(id); }, [messages.length, tail && textOf(tail).length, liveRows, status]);

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
  useEffect(() => { textarea.current?.focus(); }, [activeId, view, status]);

  const activity = deriveActivity({
    error: Boolean(error || voice.error || jackboyVoice.error || live.call.error),
    listening: voice.listening || (live.live && live.mode === "listening" && !live.call.muted),
    speaking: voice.speaking || jackboyVoice.speaking || (live.live && live.mode === "speaking"),
    toolRunning: live.working || (busy && Boolean(tail?.role === "assistant" && tail.parts.some((x) => isToolUIPart(x) && (x.state === "input-streaming" || x.state === "input-available")))),
    chatStatus: status, liveThinking: live.live && live.mode === "thinking", codeBusy: code.busy,
    cards: view === "code" ? code.cards : code.cards.filter((c) => c.status === "pending"),
  });
  const hidden = collapsed ? Math.max(0, messages.length - KEEP_VISIBLE) : 0;
  const shown = hidden ? messages.slice(hidden) : messages;
  const modeConvos = convos.filter((c) => c.mode === view);
  const iconBtn = "inline-flex size-10 items-center justify-center rounded-full bg-transparent text-muted-foreground transition-colors hover:text-electric active:text-silver focus-visible:outline-2 focus-visible:outline-electric";

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-10 flex items-center gap-1 bg-background/90 px-2 py-2 backdrop-blur sm:gap-2 sm:px-6">
        <Link to="/" aria-label="Back to dashboard" className={iconBtn}><ArrowLeft className="size-5" /></Link>
        <button type="button" onClick={() => setHistoryOpen(true)} aria-label="Conversations" title="Conversations" className={iconBtn}><History className="size-5" /></button>
        <div role="tablist" aria-label="Mode" className="ml-1 inline-flex rounded-full border border-border p-0.5 text-xs">
          {(["chat", "code"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => switchView(v)}
            className={`min-h-8 rounded-full px-3 font-medium ${view === v ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{v === "chat" ? "Chat" : "CODE"}</button>)}
        </div>
        {activity && <span role="status" aria-live="polite" data-activity={activity}
          className={`ml-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${activity === "error" ? "text-destructive" : activity === "awaiting_approval" ? "text-warning" : "text-electric"}`}>
          <span className={`size-1.5 rounded-full bg-current ${activity !== "error" && activity !== "awaiting_approval" ? "motion-safe:animate-pulse" : ""}`} aria-hidden />{ACTIVITY_LABEL[activity]}
        </span>}
        <div className="ml-auto flex items-center">
          <button type="button" onClick={() => setToolsOpen(true)} aria-label={view === "code" ? "Project and connections" : "Shortcuts"} title="Projects, connections and settings" className={iconBtn}><SlidersHorizontal className="size-5" /></button>
          <button type="button" onClick={() => openConversation(null)} aria-label="New conversation" title="New conversation" className={iconBtn}><SquarePen className="size-5" /></button>
        </div>
      </header>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="w-80 max-w-[85vw]">
          <SheetHeader><SheetTitle>{view === "code" ? "CODE conversations" : "Conversations"}</SheetTitle><SheetDescription>Saved privately for your account on this device.</SheetDescription></SheetHeader>
          <ul className="mt-4 space-y-1 overflow-y-auto">
            {modeConvos.length === 0 && <li className="px-2 text-sm text-muted-foreground">No saved conversations yet.</li>}
            {modeConvos.map((c) => (
              <li key={c.id} className={`group flex items-center gap-1 rounded-lg ${c.id === activeId ? "bg-muted" : ""}`}>
                <button type="button" onClick={() => openConversation(c)} className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm hover:text-foreground" aria-current={c.id === activeId}>
                  {c.title}<span className="block text-[11px] text-muted-foreground">{new Date(c.updatedAt).toLocaleString()}</span>
                </button>
                <button type="button" onClick={() => deleteConversation(c.id)} aria-label={`Delete conversation ${c.title}`} className="mr-1 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-destructive"><Trash2 className="size-4" /></button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>

      <Sheet open={toolsOpen} onOpenChange={setToolsOpen}>
        <SheetContent side="right" className="w-80 max-w-[85vw] space-y-5">
          <SheetHeader><SheetTitle>{view === "code" ? "CODE target" : "Shortcuts"}</SheetTitle><SheetDescription>Repositories, connections and logs live here, off the conversation.</SheetDescription></SheetHeader>
          {view === "code" && <div>
            <label htmlFor="code-repo" className="text-xs text-muted-foreground">Project</label>
            {repoErr ? <p role="alert" className="text-sm text-destructive">{repoErr}</p> : !repos ? <p className="text-sm text-muted-foreground">Loading projects…</p> : repos.length === 0 ? (
              <p className="text-sm text-muted-foreground">No project has a linked repo yet.</p>
            ) : (
              <select id="code-repo" value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1 block min-h-10 w-full rounded-xl border border-border bg-card px-3 text-sm">
                {repos.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
              </select>
            )}
            <p className="mt-2 text-xs text-muted-foreground">CODE checks access and asks for your approval before anything runs; results open as a draft PR only.</p>
          </div>}
          <VoiceSupport />
          <nav aria-label="Secondary" className="flex flex-col gap-1 text-sm">
            <Link to="/projects" className="rounded-lg px-3 py-2 hover:bg-muted">Projects and repositories</Link>
            <Link to="/connect" className="rounded-lg px-3 py-2 hover:bg-muted">Connections</Link>
            <Link to="/updates" className="rounded-lg px-3 py-2 hover:bg-muted">Approvals</Link>
            <Link to="/site-log" className="rounded-lg px-3 py-2 hover:bg-muted">Logs</Link>
            <Link to="/settings" className="rounded-lg px-3 py-2 hover:bg-muted">Settings</Link>
          </nav>
        </SheetContent>
      </Sheet>

      <main className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 pb-6 select-text" aria-label={view === "code" ? "CODE conversation" : "Chat conversation"} aria-busy={busy}>
        {live.live && <div className="flex justify-center py-6"><VoiceOrb mode={live.mode} level={live.level} size={96} onTap={() => live.call.setMuted(!live.call.muted)} actionLabel={live.call.muted ? "Unmute microphone" : "Mute microphone"} /></div>}
        {banner && <p role="status" className="mb-4 text-sm text-muted-foreground">{banner.text} <button className="ml-2 underline" onClick={() => setBanner(null)}>Dismiss</button></p>}
        {messages.length === 0 && liveRows.length === 0 && !(view === "code" && code.cards.length) ? (
          <div className="flex min-h-[55dvh] flex-col items-center justify-center text-center">
            <Hexagon className="size-10 text-silver" aria-hidden />
            <p className="mt-4 text-2xl font-semibold text-silver">{view === "code" ? "What should we change?" : "What are we working on?"}</p>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">{view === "code"
              ? <>Describe a change{target ? <> for <button type="button" className="text-foreground underline" onClick={() => setToolsOpen(true)}>{target}</button></> : ""}. Nothing runs until you approve it.</>
              : "Type or tap the microphone to talk."}</p>
            {view === "chat" && <div className="mt-6 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-border px-4 py-2 text-sm hover:border-silver">{s}</button>)}
            </div>}
          </div>
        ) : (
          <ol className="flex flex-col gap-6 pt-4">
            {messages.length > KEEP_VISIBLE + 2 && <li className="self-center">
              <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
                {collapsed ? <><ChevronDown className="size-3.5" />Show {hidden} earlier messages</> : <><ChevronUp className="size-3.5" />Hide earlier messages</>}
              </button>
            </li>}
            {shown.map((m) => <MessageBoundary key={m.id} fallback={textOf(m)}><Bubble m={m} streaming={busy && m === tail && m.role === "assistant"} /></MessageBoundary>)}
            {liveRows.map((r, i) => <li key={`live-${i}`} className={r.role === "user" ? "self-end max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 text-[15px]" : "text-[15px] leading-relaxed"}>{r.text}{links(r.evidence).map((l) => <a key={l.url} href={l.url} className="mr-3 text-xs text-primary underline">{l.label}</a>)}</li>)}
          </ol>
        )}
        {/* CODE approval/execution controls stay intact; in Chat only cards needing a decision surface. */}
        <CodeTasks tasks={view === "code" ? code : { ...code, cards: code.cards.filter((c) => c.status === "pending") }} />
        <div ref={end} />
      </main>

      <footer className="sticky bottom-0 bg-gradient-to-t from-background via-background to-background/0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <LiveCallBar v={live} />
          {(error || voice.error || jackboyVoice.error) && <p role="alert" className="mb-2 px-2 text-xs text-destructive">{error ?? voice.error ?? jackboyVoice.error}</p>}
          {error && /credits|402/i.test(error) && <a href={CREDIT_HELP_URL} target="_blank" rel="noopener noreferrer" className="block px-2 text-xs text-primary underline">Paused: out of credits — open credit setup instructions</a>}
          {jackboyVoice.speaking && <button type="button" onClick={jackboyVoice.stop} className="mb-2 ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline"><Square className="size-3" />Stop speaking</button>}
          <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex items-end gap-2 rounded-3xl border border-border bg-card px-3 py-2 focus-within:border-silver">
            <label htmlFor="jb-msg" className="sr-only">{view === "code" ? "Describe the code change" : "Message Jackboy"}</label>
            <textarea id="jb-msg" ref={textarea} rows={1} value={text} placeholder={view === "code" ? (target ? `Change for ${target}…` : "Describe the code change") : "Message Jackboy"}
              onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) setFromVoice(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }}
              className="max-h-[200px] min-h-9 min-w-0 flex-1 resize-none overflow-y-auto overscroll-contain bg-transparent [overflow-wrap:anywhere] py-1.5 text-[15px] outline-none placeholder:text-muted-foreground" />
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

/** Tool outputs come from many tools; never assume a field is an array. */
const links = (v: unknown): EvidenceLink[] => Array.isArray(v) ? v.filter((l): l is EvidenceLink => Boolean(l) && typeof (l as EvidenceLink).url === "string" && Boolean(safeEvidenceUrl((l as EvidenceLink).url))) : [];
const textOf = (m: UIMessage) => m.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" ");

function Bubble({ m, streaming }: { m: UIMessage; streaming: boolean }) {
  if (m.role === "user") return <li className="self-end max-w-[85%] min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-3xl bg-muted px-4 py-2.5 text-[15px]">{textOf(m).replace(/^🎙\s*/, "")}</li>;
  const words = textOf(m);
  const retainedLinks = links((m.metadata as { evidence?: unknown } | undefined)?.evidence);
  return (
    <li className="group min-w-0 max-w-full text-[15px] leading-relaxed [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
      {m.parts.map((part, i) => {
        if (part.type === "text") return <MessageResponse key={i} components={{ a: ({ children }) => <span>{children}</span> }}>{part.text}</MessageResponse>;
        if (isToolUIPart(part)) return <ToolLine key={i} name={part.type === "dynamic-tool" ? part.toolName : part.type.slice(5)} state={part.state} output={part.output} errorText={part.errorText} />;
        return null;
      })}
      {!streaming && words.trim() && <CopyButton text={words} />}
      {retainedLinks.map((l) => <a key={l.url} href={l.url} className="mr-3 text-xs text-primary underline">{l.label}</a>)}
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
  const [speaking, setSpeaking] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { status().then((s) => setAvailable(s.voiceAvailable)).catch(() => setAvailable(false)); }, [status]);
  const speak = useCallback(async (words: string) => {
    setError(null);
    try {
      const r = await synth({ data: { text: words.replace(/[#*`_>|]/g, "").slice(0, 900) } });
      audio.current?.pause();
      const a = new Audio(`data:${r.mimeType};base64,${r.audioBase64}`);
      audio.current = a;
      // Speaking status follows real playback events only.
      a.onplaying = () => setSpeaking(true);
      a.onended = a.onpause = a.onerror = () => setSpeaking(false);
      await a.play();
    } catch (e) { setError(e instanceof Error ? e.message : "Jackboy's voice failed; the reply is still here as text."); throw e; }
  }, [synth]);
  const stop = useCallback(() => { audio.current?.pause(); audio.current = null; setSpeaking(false); }, []);
  return useMemo(() => ({ available, error, speaking, speak, stop }), [available, error, speaking, speak, stop]);
}

type AuthLink = { label: string; url: string; primary?: boolean };
type Authorization = { provider: string; repo: string | null; state: string; missing: string[]; links: AuthLink[]; detail: string };
const TOOL_WORDS: Record<string, string> = { authorizationHelp: "Finding the right approval link", get_status: "Checking your projects", scan_site: "Scanning the site", read_file: "Reading a file", list_files: "Looking through files", write_file: "Writing a change", open_pr: "Opening a draft pull request" };
const human = (n: string) => TOOL_WORDS[n] ?? n.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Real tool calls appear as one quiet line while running; finished ones vanish unless they failed or need an approval link. */
function ToolLine({ name, state, output, errorText }: { name: string; state: string; output: unknown; errorText?: string | undefined }) {
  const running = state === "input-streaming" || state === "input-available";
  const failed = state === "output-error" || state === "output-denied";
  const auths = (output as { authorizations?: unknown } | null)?.authorizations;
  const auth = Array.isArray(auths) ? (auths as Authorization[]).find((a) => a && a.state !== "authorized" && Array.isArray(a.links)) : undefined;
  const value = (output && typeof output === "object" ? output : null) as { blocked?: boolean; reason?: unknown; evidence?: unknown } | null;
  const evidence = links(value?.evidence);
  if (running) return <Shimmer className="my-1 block text-sm">{`${human(name)}…`}</Shimmer>;
  if (auth) {
    const link = auth.links.find((l) => l.primary && l.url.startsWith("https://github.com/")) ?? auth.links.find((l) => l.url.startsWith("https://github.com/"));
    return <p className="my-2 text-sm">{auth.provider} needs your approval{auth.repo ? ` for ${auth.repo}` : ""}.{link && <> <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-electric underline"><ExternalLink className="size-3.5" />Approve on {auth.provider}</a></>}</p>;
  }
  if (state === "approval-requested") return <p className="my-1 text-sm text-warning">{human(name)} is waiting for your approval.</p>;
  if (failed) return <p role="alert" className="my-1 text-sm text-destructive">{human(name)} didn't work{errorText ? `: ${errorText.slice(0, 200)}` : "."}</p>;
  if (value?.blocked || evidence.length) return <div className="my-2 text-sm">{value?.blocked && <p role="alert" className="text-destructive">Blocked: {String(value.reason ?? "")}</p>}<div className="flex flex-wrap gap-3">{evidence.map((l) => <a key={l.url} href={l.url} className="inline-flex items-center gap-1 text-xs text-primary underline"><ExternalLink className="size-3.5" />{l.label}</a>)}</div></div>;
  return null;
}


/** Explicit device support, microphone permission and privacy facts for voice. */
function VoiceSupport() {
  const statusFn = useServerFn(getVoiceChatStatus);
  const [info, setInfo] = useState<{ secure: boolean; mic: boolean; webrtc: boolean; stt: boolean; tts: boolean; perm: string; server: boolean | null } | null>(null);
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    const base = { secure: window.isSecureContext, mic: Boolean(navigator.mediaDevices?.getUserMedia), webrtc: typeof RTCPeerConnection !== "undefined",
      stt: Boolean(w["SpeechRecognition"] || w["webkitSpeechRecognition"]), tts: "speechSynthesis" in window, perm: "unknown", server: null as boolean | null };
    setInfo(base);
    navigator.permissions?.query({ name: "microphone" as PermissionName }).then((p) => setInfo((i) => i && { ...i, perm: p.state })).catch(() => undefined);
    statusFn().then((s) => setInfo((i) => i && { ...i, server: s.voiceAvailable })).catch(() => setInfo((i) => i && { ...i, server: false }));
  }, [statusFn]);
  if (!info) return null;
  const row = (label: string, ok: boolean | null, note?: string) => <li className="flex justify-between gap-2"><span>{label}</span><span className={ok ? "text-success" : ok === null ? "text-muted-foreground" : "text-warning"}>{ok === null ? "Checking" : ok ? "Yes" : "No"}{note ? ` · ${note}` : ""}</span></li>;
  return (
    <section aria-label="Voice and privacy" className="space-y-2 text-xs">
      <h3 className="text-sm font-semibold text-silver">Voice and privacy</h3>
      <ul className="space-y-1 text-muted-foreground">
        {row("Two-way voice on this device", info.secure && info.mic && info.webrtc)}
        {row("Microphone permission", info.perm === "granted" ? true : info.perm === "denied" ? false : null, info.perm === "prompt" ? "will ask" : info.perm === "denied" ? "blocked in browser" : undefined)}
        {row("Dictation (speech to text)", info.stt)}
        {row("Spoken replies on device", info.tts)}
        {row("Jackboy voice service", info.server)}
      </ul>
      <p className="text-muted-foreground">The microphone runs only after you tap it and stops when you end the call or leave. Audio is not recorded or stored; only the text transcript is kept in your conversation. Spoken requests use the same permissions and approvals as typing, and sensitive actions still need a passkey on screen.</p>
    </section>
  );
}

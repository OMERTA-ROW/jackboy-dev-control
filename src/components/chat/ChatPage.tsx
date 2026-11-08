import { Link, useNavigate, useRouteContext, type ErrorComponentProps } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { useServerFn } from "@tanstack/react-start";
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronUp, ExternalLink, Hexagon, History, NotebookText, SlidersHorizontal, Square, SquarePen, Users } from "lucide-react";
import { getVoiceChatStatus, synthesizeJackboy } from "@/lib/passport.functions";
import { supabase } from "@/integrations/supabase/client";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useChatVoice, VoiceButtons } from "@/components/ChatVoice";
import { LiveCallBar, StartVoiceButton, useLiveCall, type LiveRow } from "@/components/LiveVoiceCall";
import { CodeTasks, useCodeTasks } from "@/components/CodeTasks";
import { VoiceOrb } from "@/components/VoiceOrb";
import { ChatMessageActions } from "@/components/ChatMessageActions";
import { forkConversation, messageTime, responseReserve, retryDraft } from "@/lib/chat-workflow";
import { composerHeight, frameBatcher, preservedScrollTop, feedbackKey, followTarget, isNearBottom, nextFollow, parseFeedback, toggleFeedback, type Feedback } from "@/lib/chat-scroll";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { safeEvidenceUrl, type EvidenceLink } from "@/lib/chat-action";
import { CREDIT_HELP_URL } from "@/lib/work-policy";
import { getProjectHub } from "@/lib/project-hub.functions";
import { ACTIVITY_LABEL, deriveActivity } from "@/lib/chat-status";
import { historyKey, loadConversations, titleFrom, type ChatMode, type StoredMessage } from "@/lib/chat-history";
import { changedMessages, fingerprint, SAVE_BATCH } from "@/lib/chat-threads";
import { authorLabel, JACKBOY_KEY, observerLabel, type ContextKind } from "@/lib/chat-context";
import { deleteChatThread, getChatContextBrief, getChatThread, listChatThreads, saveChatThread } from "@/lib/chat-threads.functions";
import { ChatHistorySheet, type ThreadRow } from "@/components/chat/ChatHistorySheet";
import { ChatContextSheet, ContextNotesCard, type ContextChoice } from "@/components/chat/ChatContextSheet";
import { ChatStatusLine } from "@/components/chat/ChatStatusLine";
import { AttachButton, MessageAttachments, PendingChips, usePendingAttachments } from "@/components/chat/ChatAttachments";

/** Page-level recovery: conversations are saved to the account, so reloading keeps them. */
export function ChatError({ error, reset }: ErrorComponentProps) {
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Prefs = { saveHistory: boolean; statusLine: boolean };
const DEFAULT_PREFS: Prefs = { saveHistory: true, statusLine: true };
type Ctx = ContextChoice & { projectId: string | null; hasRepo: boolean };
const JACKBOY_CTX: Ctx = { key: JACKBOY_KEY, name: "Jackboy", kind: "jackboy", projectId: null, hasRepo: false };

const storedMode = (): ChatMode => { try { return sessionStorage.getItem("jackboy.chat.view") === "code" ? "code" : "chat"; } catch { return "chat"; } };
const setStoredMode = (m: ChatMode) => { try { sessionStorage.setItem("jackboy.chat.view", m); } catch { /* ignore */ } };
const takeSession = (k: string) => { try { const v = sessionStorage.getItem(k); sessionStorage.removeItem(k); return v; } catch { return null; } };

export function ChatPage({ threadId }: { threadId: string }) {
  const { user, role } = useRouteContext({ from: "/_authenticated" });
  if (role !== "owner") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <Hexagon className="size-10 text-silver" aria-hidden />
        <p className="text-lg font-semibold text-silver">Jackboy Chat is owner-only</p>
        <p className="max-w-sm text-sm text-muted-foreground">Your account is signed in as {role}. Chat, voice and attachments are limited to the owner.</p>
        <Link to="/" className="rounded-full border border-border px-4 py-2 text-sm hover:border-silver">Back to dashboard</Link>
      </div>
    );
  }
  return <OwnerChat threadId={threadId} userId={user.id} role={role} />;
}

function OwnerChat({ threadId, userId, role }: { threadId: string; userId: string; role: string }) {
  const navigate = useNavigate();
  const code = useCodeTasks();
  const activeId = threadId;
  const [view, setView] = useState<ChatMode>(storedMode);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [ctx, setCtx] = useState<Ctx>(JACKBOY_CTX);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const prefsKey = `jackboy.chat.prefs.${userId}`;
  useEffect(() => { try { setPrefs({ ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(prefsKey) ?? "{}") as Partial<Prefs>) }); } catch { /* defaults */ } }, [prefsKey]);
  const setPref = (k: keyof Prefs, v: boolean) => setPrefs((p) => { const n = { ...p, [k]: v }; try { localStorage.setItem(prefsKey, JSON.stringify(n)); } catch { /* memory only */ } return n; });

  const hub = useServerFn(getProjectHub);
  const listThreads = useServerFn(listChatThreads);
  const getThread = useServerFn(getChatThread);
  const saveThread = useServerFn(saveChatThread);
  const removeThread = useServerFn(deleteChatThread);
  const getBrief = useServerFn(getChatContextBrief);
  const [repos, setRepos] = useState<{ id: string; name: string }[] | null>(null);
  const [repoErr, setRepoErr] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  useEffect(() => {
    if (view !== "code" || repos) return;
    // Only project names reach the browser view; repository paths stay in Projects.
    hub().then((h) => { const list = h.projects.filter((p) => p.github_repo).map((p) => ({ id: p.id, name: p.name })); setRepos(list); if (list[0]) setTarget((t) => t || (list[0]?.name ?? "")); })
      .catch((e) => setRepoErr((e as Error).message));
  }, [view, repos, hub]);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: "/api/chat",
    headers: async (): Promise<Record<string, string>> => {
      const { data } = await supabase.auth.getSession();
      return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
    },
  }), []);
  const { messages, sendMessage, setMessages, status, stop } = useChat({ id: threadId, transport, onError: (e) => setError(e.message.includes("402") ? "AI credits are used up. Add credits in Settings → Plans & credits." : e.message) });
  const busy = status === "submitted" || status === "streaming";
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const observedTimes = useRef(new Map<string, number>());
  const loadedIds = useRef(new Set<string>());
  // Record arrival once, never Date.now() in a rendered timestamp. Legacy history stays unknown.
  useEffect(() => {
    let changed = false;
    const stamped = messages.map((m) => {
      if (messageTime(m as StoredMessage) !== null || loadedIds.current.has(m.id)) return m;
      const createdAt = observedTimes.current.get(m.id) ?? Date.now();
      observedTimes.current.set(m.id, createdAt); changed = true;
      return { ...m, metadata: { ...(m.metadata as object ?? {}), createdAt } };
    });
    if (changed) setMessages(stamped);
  }, [messages, setMessages]);

  // ---- Saved conversations (account storage) ----
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [threadsErr, setThreadsErr] = useState<string | null>(null);
  const refreshThreads = useCallback(() => listThreads().then((t) => { setThreads(t); setThreadsErr(null); return t; }).catch((e) => { setThreadsErr((e as Error).message); return null; }), [listThreads]);
  useEffect(() => { void refreshThreads(); }, [refreshThreads]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const savedPrints = useRef(new Map<string, string>());
  const savedContext = useRef<string>(JACKBOY_KEY);
  const applyContext = useCallback(async (key: string, fallback?: Partial<Ctx>) => {
    if (key === JACKBOY_KEY) { setCtx(JACKBOY_CTX); return; }
    setCtx({ ...JACKBOY_CTX, key, name: fallback?.name ?? "…", kind: (fallback?.kind as ContextKind) ?? "agent" });
    try {
      const { brief } = await getBrief({ data: { key } });
      setCtx({ key, name: brief.name, kind: brief.kind, projectId: brief.projectId, hasRepo: brief.hasRepo });
    } catch (e) { setError(`That context couldn't be opened: ${(e as Error).message}. Back to Jackboy.`); setCtx(JACKBOY_CTX); }
  }, [getBrief]);
  const loadThread = useCallback(async () => {
    setLoadState("loading"); setLoadErr(null);
    try {
      const r = await getThread({ data: { id: threadId } });
      const msgs = r.messages as unknown as UIMessage[];
      savedPrints.current = new Map(msgs.map((m) => [m.id, fingerprint(m)]));
      loadedIds.current = new Set(msgs.map((m) => m.id));
      setMessages(msgs);
      if (r.thread) { setView(r.thread.mode); setStoredMode(r.thread.mode); savedContext.current = r.thread.context_key; await applyContext(r.thread.context_key); }
      setLoadState("ready");
    } catch (e) { setLoadErr((e as Error).message); setLoadState("error"); }
    const notice = takeSession(`jackboy.chat.notice.${threadId}`); if (notice) setDraftNotice(notice);
    const draft = takeSession(`jackboy.chat.draft.${threadId}`); if (draft) setText(draft);
  }, [getThread, threadId, setMessages, applyContext]);
  useEffect(() => { void loadThread(); }, [loadThread]);

  const persist = useCallback(async (list: StoredMessage[], contextKey: string) => {
    const changed = changedMessages(list, savedPrints.current);
    if (!changed.length && contextKey === savedContext.current) return true;
    try {
      const title = titleFrom(list);
      for (let i = 0; i < Math.max(1, changed.length); i += SAVE_BATCH) {
        const batch = changed.slice(i, i + SAVE_BATCH);
        await saveThread({ data: { id: threadId, mode: view, title, contextKey, messages: batch.map((m) => {
          const meta = (m.metadata ?? {}) as Record<string, unknown>;
          return { uiId: m.id, role: m.role, author: typeof meta["author"] === "string" ? (meta["author"] as string).slice(0, 80) : m.role === "user" ? "You" : "Jackboy", contextKey: typeof meta["contextKey"] === "string" ? (meta["contextKey"] as string) : null, parts: m.parts, metadata: meta };
        }) } });
        for (const m of batch) savedPrints.current.set(m.id, fingerprint(m));
      }
      savedContext.current = contextKey;
      setSaveError(null);
      setThreads((cur) => { const row = { id: threadId, title, mode: view, context_key: contextKey, updated_at: new Date().toISOString() }; return [row, ...(cur ?? []).filter((t) => t.id !== threadId)]; });
      return true;
    } catch (e) { setSaveError(`Not saved: ${(e as Error).message}. Your messages are still on screen; it will retry with the next message.`); return false; }
  }, [saveThread, threadId, view]);
  useEffect(() => {
    // Save after the user turn is submitted and after each reply, not on every streamed token.
    if (loadState !== "ready" || !prefs.saveHistory || status === "streaming" || !messages.length) return;
    const t = setTimeout(() => { void persist(messages as StoredMessage[], ctx.key); }, 400);
    return () => clearTimeout(t);
  }, [messages, status, loadState, prefs.saveHistory, ctx.key, persist]);

  const openThread = (id: string) => { stop(); setHistoryOpen(false); if (id !== threadId) void navigate({ to: "/chat/$threadId", params: { threadId: id } }); };
  const newThread = (mode: ChatMode = view) => { stop(); setStoredMode(mode); void navigate({ to: "/chat/$threadId", params: { threadId: crypto.randomUUID() } }); };
  const switchView = (v: ChatMode) => { if (v === view) return; setStoredMode(v); const latest = threads?.find((t) => t.mode === v); if (latest) openThread(latest.id); else newThread(v); };
  const deleteThread = async (id: string) => {
    try {
      const r = await removeThread({ data: { id } });
      if (r.attachmentsLeft) setError(`Conversation deleted; ${r.attachmentsLeft} attachment file(s) couldn't be removed.`);
      await refreshThreads();
      if (id === threadId) newThread();
    } catch (e) { setError((e as Error).message); }
  };

  // One-press move of conversations that were saved only in this browser into the account.
  const [localCount, setLocalCount] = useState(0);
  const [importing, setImporting] = useState<string | null>(null);
  useEffect(() => { setLocalCount(loadConversations(localStorage, userId).length); }, [userId]);
  const importLocal = async () => {
    const list = loadConversations(localStorage, userId);
    const failed: typeof list = [];
    for (const [n, c] of list.entries()) {
      setImporting(`Importing ${n + 1} of ${list.length}…`);
      try {
        const id = UUID.test(c.id) ? c.id : crypto.randomUUID();
        for (let i = 0; i < Math.max(1, c.messages.length); i += SAVE_BATCH) {
          await saveThread({ data: { id, mode: c.mode, title: (c.title || "Imported conversation").slice(0, 120), contextKey: JACKBOY_KEY,
            messages: c.messages.slice(i, i + SAVE_BATCH).map((m) => ({ uiId: m.id.slice(0, 200), role: m.role, author: m.role === "user" ? "You" : "Jackboy", contextKey: null, parts: m.parts, metadata: { ...((m.metadata ?? {}) as object), imported: true } })) } });
        }
      } catch { failed.push(c); }
    }
    try { if (failed.length) localStorage.setItem(historyKey(userId), JSON.stringify(failed)); else localStorage.removeItem(historyKey(userId)); } catch { /* keep */ }
    setLocalCount(failed.length); setImporting(null);
    if (failed.length) setError(`${failed.length} conversation(s) couldn't be imported and stay on this device.`);
    await refreshThreads();
  };

  const selectContext = (c: ContextChoice) => {
    if (c.key === ctx.key) return;
    setNotesOpen(c.key !== JACKBOY_KEY);
    void applyContext(c.key, c);
  };

  const attach = usePendingAttachments(userId, threadId);
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

  const chatContext = () => `${ctx.key !== JACKBOY_KEY ? `Current chat context: ${ctx.name} (stored notes only; never invent facts).\n` : ""}${messages.slice(-12).map((m) => `${m.role === "user" ? "Owner" : "Jackboy"}: ${textOf(m)}`).join("\n")}`.slice(-6000);
  const [liveRows, setLiveRows] = useState<LiveRow[]>([]);
  const addVoiceTranscript = (rows: LiveRow[]) =>
    setMessages((cur) => [...cur, ...rows.filter((r) => r.text.trim() || r.evidence?.length).map((r, i) => ({ id: `voice-${Date.now()}-${i}`, role: r.role, metadata: { voice: true, createdAt: Date.now(), evidence: r.evidence ?? [], author: r.role === "user" ? "You" : "Jackboy", contextKey: ctx.key, contextName: ctx.name }, parts: [{ type: "text" as const, text: r.text.trim() }] }))]);
  const live = useLiveCall({ chatContext, onLiveRows: setLiveRows, onTranscript: addVoiceTranscript, onCodeCard: code.receive });

  const userMeta = () => ({ createdAt: Date.now(), author: "You", contextKey: ctx.key, contextName: ctx.name });
  const addUser = (t: string) => {
    const id = crypto.randomUUID();
    setSubmitAnchor({ id, reserve: 0, pending: true });
    setMessages((cur) => [...cur, { id, role: "user", metadata: userMeta(), parts: [{ type: "text", text: t }] }]);
  };
  const send = async (t: string) => {
    const withFiles = view === "chat" && attach.hasReady;
    if ((!t.trim() && !withFiles) || busy || code.busy) return;
    if (attach.busy) { setError("Wait for the attachment to finish uploading."); return; }
    setError(null); setDraftNotice(null); jackboyVoice.stop(); voice.stopSpeaking();
    if (view === "code") {
      // Allow/Deny phrases still go to the pending card; anything else becomes a request for the selected project.
      const direct = /^\s*(CODE\s+[^:\n]+:|(allow|deny)\s+CODE\s)/i.test(t);
      if (!direct && !target) { setError("Pick a project first."); setToolsOpen(true); return; }
      if (await code.submit(direct ? t : `CODE ${target}: ${t.trim()}`)) { addUser(direct ? t : `${target}: ${t.trim()}`); setText(""); setFromVoice(false); }
      return;
    }
    if (!withFiles && await code.submit(t)) { addUser(t); setText(""); setFromVoice(false); return; }
    const id = crypto.randomUUID();
    setSubmitAnchor({ id, reserve: 0, pending: true });
    const words = t.trim() || "Please describe what you see in the attachment.";
    void sendMessage({ id, role: "user", parts: [{ type: "text", text: words }, ...(withFiles ? attach.parts : [])], metadata: { ...userMeta(), ...(fromVoice ? { voice: true } : {}) } }, { body: { contextKey: ctx.key } });
    setText(""); setFromVoice(false); attach.clear();
  };

  // One page-level scroll. Follow only while the reader is near the bottom; a deliberate upward
  // scroll releases follow so streamed tokens never yank them away. Growth is observed with a
  // ResizeObserver and pinned instantly (no smooth animation fighting token updates = no jitter).
  const end = useRef<HTMLDivElement>(null);
  const chatHeader = useRef<HTMLElement>(null);
  const composerFooter = useRef<HTMLElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const leadingSpace = useRef<HTMLDivElement>(null);
  const [submitAnchor, setSubmitAnchor] = useState<{ id: string; reserve: number; pending: boolean } | null>(null);
  const convo = useRef<HTMLElement>(null);
  const followRef = useRef({ follow: true, lastTop: 0 });
  const [atBottom, setAtBottom] = useState(true);
  const metrics = () => ({ scrollTop: window.scrollY, viewportHeight: window.visualViewport?.height ?? window.innerHeight, scrollHeight: document.documentElement.scrollHeight });
  const pin = useCallback(() => { const t = followTarget(followRef.current.follow, metrics()); if (t !== null) { window.scrollTo({ top: t, behavior: "instant" as ScrollBehavior }); followRef.current.lastTop = t; } }, []);
  useEffect(() => {
    const on = () => { followRef.current = nextFollow(followRef.current, metrics()); setAtBottom(followRef.current.follow); };
    // Touch/wheel up is explicit intent, even before scrollTop changes (iOS momentum).
    const up = () => { if (!isNearBottom(metrics(), 8)) { followRef.current.follow = false; setAtBottom(false); } };
    const wheel = (e: WheelEvent) => { if (e.deltaY < 0) { followRef.current.follow = false; setAtBottom(false); } };
    window.addEventListener("scroll", on, { passive: true }); window.addEventListener("wheel", wheel, { passive: true }); window.addEventListener("touchmove", up, { passive: true });
    // All growth/resize signals coalesce into at most one pin per frame (no lag, no jitter).
    const batch = frameBatcher(pin);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => batch.schedule()) : null;
    if (convo.current) ro?.observe(convo.current);
    const vv = () => {
      const viewport = window.visualViewport;
      const obscured = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      if (composerFooter.current) composerFooter.current.style.bottom = `${obscured}px`;
      batch.schedule();
    };
    vv();
    window.visualViewport?.addEventListener("resize", vv); window.addEventListener("resize", vv);
    return () => { batch.cancel(); window.removeEventListener("scroll", on); window.removeEventListener("wheel", wheel); window.removeEventListener("touchmove", up); ro?.disconnect(); window.visualViewport?.removeEventListener("resize", vv); window.removeEventListener("resize", vv); };
  }, [pin]);
  const tail = messages.at(-1);
  useEffect(() => { const id = requestAnimationFrame(pin); return () => cancelAnimationFrame(id); }, [messages.length, tail && textOf(tail).length, liveRows, status, pin]);
  const jumpToLatest = () => { followRef.current.follow = true; setAtBottom(true); pin(); };
  // A short submitted turn lands mid-viewport; reserved space is consumed by the reply.
  useLayoutEffect(() => {
    if (!submitAnchor?.pending) return;
    const node = document.getElementById(`message-${submitAnchor.id}`);
    if (!node) return;
    const usable = Math.max(0, (window.visualViewport?.height ?? window.innerHeight) - (chatHeader.current?.offsetHeight ?? 0) - (composerFooter.current?.offsetHeight ?? 0));
    const reserve = responseReserve(usable, node.offsetHeight);
    if (leadingSpace.current && messages.findIndex((m) => m.id === submitAnchor.id) === 0) {
      leadingSpace.current.style.height = `${Math.max(0, usable / 2 - node.offsetHeight / 2 - 16)}px`;
    }
    if (spacer.current) spacer.current.style.height = `${reserve}px`;
    followRef.current.follow = true; setAtBottom(true);
    setSubmitAnchor({ id: submitAnchor.id, reserve, pending: false });
    pin();
  }, [messages, submitAnchor, pin]);
  useLayoutEffect(() => {
    if (!submitAnchor || submitAnchor.pending || !spacer.current) return;
    const node = document.getElementById(`message-${submitAnchor.id}`);
    if (!node) return;
    const growth = Math.max(0, (end.current?.getBoundingClientRect().top ?? 0) - node.getBoundingClientRect().bottom);
    spacer.current.style.height = `${Math.max(0, submitAnchor.reserve - growth)}px`;
  }, [messages, liveRows, submitAnchor, status]);

  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  useEffect(() => { setFeedback(parseFeedback(localStorage.getItem(feedbackKey(userId)))); }, [userId]);
  const rate = (id: string, v: Feedback) => {
    const next = toggleFeedback(feedback, id, v);
    try { localStorage.setItem(feedbackKey(userId), JSON.stringify(next)); setFeedback(next); }
    catch { setError("Rating could not be saved on this device. Please check browser storage permissions."); }
  };
  const branch = async (id: string, mode: ChatMode, retry = false) => {
    if (busy || code.busy || live.live) return;
    const request = retry ? retryDraft(messages as StoredMessage[], id) : null;
    if (retry && !request) { setError("The original request is unavailable."); return; }
    const nextBranch = forkConversation(messages as StoredMessage[], request?.throughId ?? id, mode, crypto.randomUUID(), Date.now());
    if (request) nextBranch.messages = nextBranch.messages.slice(0, -1);
    // Persist before switching: failed storage never produces a fake saved branch.
    try {
      for (let i = 0; i < Math.max(1, nextBranch.messages.length); i += SAVE_BATCH) {
        await saveThread({ data: { id: nextBranch.id, mode, title: nextBranch.title.slice(0, 120), contextKey: ctx.key,
          messages: nextBranch.messages.slice(i, i + SAVE_BATCH).map((m) => ({ uiId: m.id.slice(0, 200), role: m.role, author: m.role === "user" ? "You" : "Jackboy", contextKey: null, parts: m.parts, metadata: (m.metadata ?? {}) as Record<string, unknown> })) } });
      }
    } catch (e) { setError(`Branch could not be saved. Your original conversation is unchanged. ${(e as Error).message}`); return; }
    try {
      if (request) sessionStorage.setItem(`jackboy.chat.draft.${nextBranch.id}`, request.text);
      sessionStorage.setItem(`jackboy.chat.notice.${nextBranch.id}`, retry ? "Retry draft ready. Nothing was rerun. Review before sending; commands may repeat external actions." : mode === "code" ? "CODE branch saved. Nothing submitted or executed. Choose a project and review your draft." : "Conversation branched. The original is unchanged; past actions are not rerun.");
    } catch { /* notice only */ }
    setStoredMode(mode);
    openThread(nextBranch.id);
  };

  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    // GitHub App setup returns to /chat?github=…; the /chat redirect hands those values over here.
    const fromUrl = window.location.search;
    const q = new URLSearchParams(fromUrl.includes("github=") ? fromUrl : takeSession("jackboy.chat.banner") ?? "");
    const g = q.get("github");
    if (!g) return;
    setBanner(g === "error" ? { ok: false, text: `GitHub authorization didn't complete: ${q.get("reason") ?? "unknown error"}` }
      : { ok: g === "connected", text: `GitHub App installed on ${q.get("account")}. ${q.get("missing") ? `Still missing: ${q.get("missing")}. ` : ""}${q.get("verified") ?? ""}` });
    if (fromUrl) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const textarea = useRef<HTMLTextAreaElement>(null);
  // Auto-grow up to a keyboard-aware max; only then does the box scroll internally.
  const sizeComposer = useCallback(() => { const t = textarea.current; if (!t) return; t.style.height = "auto"; const r = composerHeight(t.scrollHeight, window.visualViewport?.height ?? window.innerHeight); t.style.height = `${r.height}px`; t.style.overflowY = r.overflow ? "auto" : "hidden"; }, []);
  useLayoutEffect(sizeComposer, [text, sizeComposer]);
  useEffect(() => { const vv = window.visualViewport; vv?.addEventListener("resize", sizeComposer); return () => vv?.removeEventListener("resize", sizeComposer); }, [sizeComposer]);
  // Revealing earlier history inserts content above: keep the reader's place.
  const historyAnchor = useRef<{ top: number; height: number } | null>(null);
  const toggleHistory = () => { historyAnchor.current = { top: window.scrollY, height: document.documentElement.scrollHeight }; followRef.current.follow = false; setCollapsed(!collapsed); };
  useLayoutEffect(() => { const a = historyAnchor.current; if (!a) return; historyAnchor.current = null; const top = preservedScrollTop(a.top, a.height, document.documentElement.scrollHeight); window.scrollTo({ top, behavior: "instant" as ScrollBehavior }); followRef.current.lastTop = top; }, [collapsed]);
  useEffect(() => { if (loadState === "ready") textarea.current?.focus({ preventScroll: true }); }, [activeId, view, loadState, status]);

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
  const iconBtn = "inline-flex size-10 items-center justify-center rounded-full bg-transparent text-muted-foreground transition-colors hover:text-electric active:text-silver focus-visible:outline-2 focus-visible:outline-electric";
  const ctxOf = (m: UIMessage) => ((m.metadata as { contextKey?: unknown } | undefined)?.contextKey as string | undefined) ?? JACKBOY_KEY;
  const ctxNameOf = (m: UIMessage) => ((m.metadata as { contextName?: unknown } | undefined)?.contextName as string | undefined) ?? "Jackboy";

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header ref={chatHeader} className="sticky top-0 z-10 bg-background/90 backdrop-blur">
        <div className="flex items-center gap-1 px-2 py-2 sm:gap-2 sm:px-6">
          <Link to="/" aria-label="Back to dashboard" className={iconBtn}><ArrowLeft className="size-5" /></Link>
          <button type="button" onClick={() => setHistoryOpen(true)} aria-label="Conversations" title="Conversations and search" className={iconBtn}><History className="size-5" /></button>
          <div role="tablist" aria-label="Mode" className="ml-1 inline-flex rounded-full border border-border p-0.5 text-xs">
            {(["chat", "code"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => switchView(v)}
              className={`min-h-8 rounded-full px-3 font-medium ${view === v ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{v === "chat" ? "Chat" : "CODE"}</button>)}
          </div>
          {view === "chat" && <button type="button" onClick={() => setContextOpen(true)} title="Talk to another agent or project" aria-label={`Talking to ${ctx.name}. Change`}
            className="ml-1 inline-flex min-h-8 max-w-[9rem] items-center gap-1 rounded-full border border-border px-2.5 text-xs hover:border-silver sm:max-w-[14rem]">
            <Users className="size-3.5 shrink-0 text-electric" aria-hidden /><span className="truncate">{ctx.name}</span>
          </button>}
          {activity && <span role="status" aria-live="polite" data-activity={activity}
            className={`ml-1 hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs sm:inline-flex ${activity === "error" ? "text-destructive" : activity === "awaiting_approval" ? "text-warning" : "text-electric"}`}>
            <span className={`size-1.5 rounded-full bg-current ${activity !== "error" && activity !== "awaiting_approval" ? "motion-safe:animate-pulse" : ""}`} aria-hidden />{ACTIVITY_LABEL[activity]}
          </span>}
          <div className="ml-auto flex items-center">
            {view === "chat" && ctx.key !== JACKBOY_KEY && <button type="button" onClick={() => setNotesOpen((o) => !o)} aria-pressed={notesOpen} aria-label={`Stored notes for ${ctx.name}`} title="Stored notes Jackboy uses" className={iconBtn}><NotebookText className="size-5" /></button>}
            <button type="button" onClick={() => setToolsOpen(true)} aria-label={view === "code" ? "Project and connections" : "Shortcuts and chat settings"} title="Projects, links and chat settings" className={iconBtn}><SlidersHorizontal className="size-5" /></button>
            <button type="button" onClick={() => newThread()} aria-label="New conversation" title="New conversation" className={iconBtn}><SquarePen className="size-5" /></button>
          </div>
        </div>
        {activity && <p className="-mt-1 px-4 pb-1 text-[11px] text-electric sm:hidden" aria-hidden>{ACTIVITY_LABEL[activity]}</p>}
        {prefs.statusLine && <ChatStatusLine projectId={view === "chat" ? ctx.projectId : null} hasRepo={view === "chat" && ctx.hasRepo} />}
      </header>

      <ChatHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} mode={view} threads={threads} loadError={threadsErr} activeId={activeId}
        onOpen={openThread} onDelete={(id) => void deleteThread(id)} localCount={localCount} onImport={() => void importLocal()} importing={importing} />
      <ChatContextSheet open={contextOpen} onOpenChange={setContextOpen} current={ctx.key} onSelect={selectContext} />

      <Sheet open={toolsOpen} onOpenChange={setToolsOpen}>
        <SheetContent side="right" className="w-80 max-w-[85vw] space-y-5 overflow-y-auto">
          <SheetHeader><SheetTitle>{view === "code" ? "CODE target" : "Shortcuts"}</SheetTitle><SheetDescription>Projects, links and chat settings live here, off the conversation.</SheetDescription></SheetHeader>
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
          <section aria-label="Chat settings" className="space-y-2">
            <h3 className="text-sm font-semibold text-silver">Chat settings</h3>
            <Toggle label="Save conversations to my account" on={prefs.saveHistory} onChange={(v) => setPref("saveHistory", v)} />
            <Toggle label="Status line" on={prefs.statusLine} onChange={(v) => setPref("statusLine", v)} />
            {!prefs.saveHistory && <p className="text-xs text-warning">New messages aren't saved while this is off. Earlier saved messages stay.</p>}
          </section>
          <VoiceSupport />
          <nav aria-label="Secondary" className="flex flex-col gap-1 text-sm">
            <Link to="/research" className="rounded-lg px-3 py-2 hover:bg-muted">Research</Link>
            {ctx.projectId
              ? <Link to="/project/$id" params={{ id: ctx.projectId }} className="rounded-lg px-3 py-2 hover:bg-muted">GitHub issues and pull requests · {ctx.name}</Link>
              : <Link to="/projects" className="rounded-lg px-3 py-2 hover:bg-muted">Projects, GitHub issues and pull requests</Link>}
            <Link to="/omni" className="rounded-lg px-3 py-2 hover:bg-muted">OMNI handoffs</Link>
            <Link to="/updates" className="rounded-lg px-3 py-2 hover:bg-muted">Approvals</Link>
            <Link to="/access" className="rounded-lg px-3 py-2 hover:bg-muted">Audit list</Link>
            <Link to="/site-log" className="rounded-lg px-3 py-2 hover:bg-muted">Site log</Link>
            <Link to="/reports" className="rounded-lg px-3 py-2 hover:bg-muted">Reports</Link>
            <Link to="/connect" className="rounded-lg px-3 py-2 hover:bg-muted">Connections</Link>
            <Link to="/settings" className="rounded-lg px-3 py-2 hover:bg-muted">Settings and Emergency Stop</Link>
          </nav>
        </SheetContent>
      </Sheet>

      <main ref={convo} style={{ overflowAnchor: "none" }} className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 pb-6 select-text" aria-label={view === "code" ? "CODE conversation" : "Chat conversation"} aria-busy={busy || loadState === "loading"}>
        {live.live && <div className="flex justify-center py-6"><VoiceOrb mode={live.mode} level={live.level} size={96} onTap={() => live.call.setMuted(!live.call.muted)} actionLabel={live.call.muted ? "Unmute microphone" : "Mute microphone"} /></div>}
        {banner && <p role="status" className="mb-4 text-sm text-muted-foreground">{banner.text} <button className="ml-2 underline" onClick={() => setBanner(null)}>Dismiss</button></p>}
        {view === "chat" && notesOpen && ctx.key !== JACKBOY_KEY && <ContextNotesCard key={ctx.key} contextKey={ctx.key} onClose={() => setNotesOpen(false)} />}
        {loadState === "loading" ? <p className="py-16 text-center text-sm text-muted-foreground">Opening conversation…</p>
        : loadState === "error" ? <div role="alert" className="py-16 text-center text-sm"><p className="text-destructive">Couldn't open this conversation: {loadErr}</p><button type="button" onClick={() => void loadThread()} className="mt-3 rounded-full border border-border px-4 py-2 hover:border-silver">Try again</button></div>
        : messages.length === 0 && liveRows.length === 0 && !(view === "code" && code.cards.length) ? (
          <div className="flex min-h-[50dvh] flex-col items-center justify-center text-center">
            <Hexagon className="size-10 text-silver" aria-hidden />
            <p className="mt-4 text-2xl font-semibold text-silver">{view === "code" ? "What should we change?" : ctx.key !== JACKBOY_KEY ? `Ask about ${ctx.name}` : "What are we working on?"}</p>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">{view === "code"
              ? <>Describe a change{target ? <> for <button type="button" className="text-foreground underline" onClick={() => setToolsOpen(true)}>{target}</button></> : ""}. Nothing runs until you approve it.</>
              : ctx.key !== JACKBOY_KEY ? `Jackboy answers from ${ctx.name}'s stored notes only. Type, talk, or attach a photo or short video.` : "Type, tap the microphone to talk, or attach a photo or short video."}</p>
            {view === "chat" && ctx.key === JACKBOY_KEY && <div className="mt-6 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => void send(s)} className="rounded-full border border-border px-4 py-2 text-sm hover:border-silver">{s}</button>)}
            </div>}
          </div>
        ) : (
          <>
          <div ref={leadingSpace} aria-hidden="true" />
          <ol className="flex flex-col gap-6 pt-4">
            {messages.length > KEEP_VISIBLE + 2 && <li className="self-center">
              <button type="button" onClick={toggleHistory} aria-expanded={!collapsed} className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
                {collapsed ? <><ChevronDown className="size-3.5" />Show {hidden} earlier messages</> : <><ChevronUp className="size-3.5" />Hide earlier messages</>}
              </button>
            </li>}
            {shown.map((m, i) => {
              const prev = i > 0 ? shown[i - 1] : hidden > 0 ? messages[hidden - 1] : undefined;
              const switched = m.role === "user" && prev && ctxOf(prev) !== ctxOf(m);
              return (
                <MessageBoundary key={m.id} fallback={textOf(m)}>
                  {switched && <li className="self-center text-[11px] text-muted-foreground">Now using {ctxNameOf(m) === "Jackboy" ? "Jackboy's own tools" : `${ctxNameOf(m)}'s stored notes`}</li>}
                  <Bubble m={m} viewerRole={role} streaming={busy && m === tail && m.role === "assistant"} disabled={busy || code.busy || live.live} rating={feedback[m.id]} onRate={(v) => rate(m.id, v)} onRetry={() => void branch(m.id, view, true)} onBranch={(mode) => void branch(m.id, mode)} />
                </MessageBoundary>
              );
            })}
            {liveRows.map((r, i) => <li key={`live-${i}`} className={r.role === "user" ? "self-end max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 text-[15px]" : "text-[15px] leading-relaxed"}>{r.text}{links(r.evidence).map((l) => <a key={l.url} href={l.url} className="mr-3 text-xs text-primary underline">{l.label}</a>)}</li>)}
          </ol>
          </>
        )}
        {/* CODE approval/execution controls stay intact; in Chat only cards needing a decision surface. */}
        <CodeTasks tasks={view === "code" ? code : { ...code, cards: code.cards.filter((c) => c.status === "pending") }} />
        <div ref={end} />
        <div ref={spacer} aria-hidden="true" />
      </main>

      <footer ref={composerFooter} className="sticky bottom-0 bg-gradient-to-t from-background via-background to-background/0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
        <div className="relative mx-auto max-w-3xl">
          {!atBottom && <button type="button" onClick={jumpToLatest} aria-label="Jump to latest message" title="Jump to latest"
            className="absolute -top-10 left-1/2 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow hover:text-electric focus-visible:outline-2 focus-visible:outline-electric"><ArrowDown className="size-4" /></button>}
          <LiveCallBar v={live} />
          {draftNotice && <p role="status" className="mb-2 px-2 text-xs text-warning">{draftNotice}</p>}
          {saveError && <p role="alert" className="mb-2 px-2 text-xs text-destructive">{saveError}</p>}
          {!prefs.saveHistory && messages.length > 0 && <p className="mb-2 px-2 text-xs text-muted-foreground">Not saving new messages (Chat settings).</p>}
          {(error || voice.error || jackboyVoice.error) && <p role="alert" className="mb-2 px-2 text-xs text-destructive">{error ?? voice.error ?? jackboyVoice.error}</p>}
          {error && /credits|402/i.test(error) && <a href={CREDIT_HELP_URL} target="_blank" rel="noopener noreferrer" className="block px-2 text-xs text-primary underline">Paused: out of credits — open credit setup instructions</a>}
          {jackboyVoice.speaking && <button type="button" onClick={jackboyVoice.stop} className="mb-2 ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline"><Square className="size-3" />Stop speaking</button>}
          {view === "chat" && <PendingChips a={attach} />}
          <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="flex items-end gap-1 rounded-3xl border border-border bg-card px-2 py-2 focus-within:border-silver sm:gap-2 sm:px-3">
            {view === "chat" && <AttachButton a={attach} disabled={busy || loadState !== "ready"} />}
            <label htmlFor="jb-msg" className="sr-only">{view === "code" ? "Describe the code change" : `Message Jackboy about ${ctx.name}`}</label>
            <textarea id="jb-msg" ref={textarea} rows={1} value={text} placeholder={view === "code" ? (target ? `Change for ${target}…` : "Describe the code change") : ctx.key !== JACKBOY_KEY ? `Ask about ${ctx.name}` : "Message Jackboy"}
              onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) setFromVoice(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }}
              onPaste={(e) => { if (view === "chat" && e.clipboardData.files.length) { e.preventDefault(); void attach.add(e.clipboardData.files); } }}
              aria-multiline="true" className="min-h-9 min-w-0 flex-1 resize-none overflow-y-hidden overscroll-contain [scrollbar-width:thin] bg-transparent [overflow-wrap:anywhere] py-1.5 text-[15px] outline-none placeholder:text-muted-foreground" />
            <VoiceButtons v={voice} />
            {busy ? <button type="button" onClick={stop} aria-label="Stop reply" className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background"><Square className="size-3.5" /></button>
              : text.trim() || (view === "chat" && attach.hasReady) ? <button type="submit" disabled={attach.busy} aria-label="Send message" className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"><ArrowUp className="size-4" /></button>
              : !live.live && <StartVoiceButton v={live} />}
          </form>
        </div>
      </footer>
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-1.5 text-left text-sm">
      <span>{label}</span>
      <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${on ? "text-electric" : "text-muted-foreground"}`}>
        {on ? "ON" : "OFF"}
        <span className={`relative h-5 w-9 rounded-full border transition-colors ${on ? "border-electric bg-electric/20" : "border-border bg-muted"}`}>
          <span className={`absolute top-0.5 size-3.5 rounded-full transition-all ${on ? "left-[1.1rem] bg-electric" : "left-0.5 bg-muted-foreground"}`} />
        </span>
      </span>
    </button>
  );
}

/** Tool outputs come from many tools; never assume a field is an array. */
const links = (v: unknown): EvidenceLink[] => Array.isArray(v) ? v.filter((l): l is EvidenceLink => Boolean(l) && typeof (l as EvidenceLink).url === "string" && Boolean(safeEvidenceUrl((l as EvidenceLink).url))) : [];
const textOf = (m: UIMessage) => m.parts.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" ");

function Bubble({ m, viewerRole, streaming, disabled, rating, onRate, onRetry, onBranch }: {
  m: UIMessage; viewerRole: string; streaming: boolean; disabled: boolean; rating?: Feedback | undefined;
  onRate: (v: Feedback) => void; onRetry: () => void; onBranch: (mode: ChatMode) => void;
}) {
  const words = textOf(m);
  const user = m.role === "user";
  const meta = m.metadata as { evidence?: unknown; author?: unknown; contextName?: unknown; contextKind?: ContextKind; voice?: unknown; visual?: unknown } | undefined;
  const retainedLinks = links(meta?.evidence);
  const label = authorLabel(m.role, meta, viewerRole);
  const observed = !user && !streaming ? observerLabel(meta?.contextKind, meta?.visual === true) : null;
  return (
    <li id={`message-${m.id}`} className={user ? "group flex max-w-[90%] min-w-0 flex-col items-end self-end text-[15px] [overflow-wrap:anywhere]" : "group min-w-0 max-w-full text-[15px] leading-relaxed [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:overflow-y-hidden [&_table]:block [&_table]:overflow-x-auto"}>
      <p className={`mb-1 text-[11px] font-medium tracking-wide ${user ? "text-muted-foreground" : "text-silver"}`}>{label}</p>
      {user ? (words.trim() && <div className="whitespace-pre-wrap rounded-3xl bg-muted px-4 py-2.5">{words.replace(/^🎙\s*/, "")}</div>) : m.parts.map((part, i) => {
        if (part.type === "text") return <MessageResponse key={i} components={{ a: ({ children }) => <span>{children}</span> }}>{part.text}</MessageResponse>;
        if (isToolUIPart(part)) return <ToolLine key={i} name={part.type === "dynamic-tool" ? part.toolName : part.type.slice(5)} state={part.state} output={part.output} errorText={part.errorText} />;
        return null;
      })}
      <MessageAttachments parts={m.parts} />
      {observed && <p className="mt-1 text-[11px] text-warning">{observed}</p>}
      {retainedLinks.map((l) => <a key={l.url} href={l.url} className="mr-3 text-xs text-primary underline">{l.label}</a>)}
      <ChatMessageActions text={words} assistant={!user} streaming={streaming} disabled={disabled} time={messageTime(m as StoredMessage)} rating={rating} onRate={onRate} onRetry={onRetry} onBranch={onBranch} />
    </li>
  );
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

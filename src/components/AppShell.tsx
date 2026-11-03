import { Link, useNavigate, useRouteContext, useRouterState } from "@tanstack/react-router";
import { LogIn, LogOut, ShieldCheck, UserRound } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import {
  LayoutGrid,
  Radar,
  Send,
  Hexagon,
  Code2,
  ScrollText,
  Plug,
  ShieldCheck,
  Globe,
  Bot,
  Workflow,
  Users,
  Library,
  Mic,
  MicOff,
  X,
  ArrowUp,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useJackboy } from "@/lib/jackboy-store";
import { chatWithJackboy, getDashboardFacts, getVoiceChatStatus, synthesizeJackboy } from "@/lib/passport.functions";

// Simple main menu; advanced pages are listed on /settings.
const NAV = [
  { to: "/", label: "Home", icon: LayoutGrid },
  { to: "/projects", label: "Projects", icon: Hexagon },
  { to: "/connect", label: "Connect", icon: Plug },
  { to: "/updates", label: "Approvals", icon: ScrollText },
  { to: "/chat", label: "Chat", icon: Bot },
  { to: "/settings", label: "Settings", icon: ShieldCheck },
] as const;

function Hex({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

type ChatMessage = { role: "user" | "assistant"; content: string };
type VoiceMode = "voice" | "text" | "silent";
type Tone = "direct" | "balanced" | "witty";

function VoiceControl() {
  const navigate = useNavigate();
  const getStatus = useServerFn(getVoiceChatStatus);
  const chat = useServerFn(chatWithJackboy);
  const synthesize = useServerFn(synthesizeJackboy);
  const dashboard = useServerFn(getDashboardFacts);
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [mode, setMode] = useState<VoiceMode>("text");
  const [tone, setTone] = useState<Tone>("balanced");
  const [volume, setVolume] = useState(0.8);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const speechRequestRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("jackboy.voice.preferences") || "{}");
      if (["voice", "text", "silent"].includes(saved.mode)) setMode(saved.mode);
      if (["direct", "balanced", "witty"].includes(saved.tone)) setTone(saved.tone);
      if (typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1) setVolume(saved.volume);
    } catch {
      /* Browser storage is optional. */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("jackboy.voice.preferences", JSON.stringify({ mode, tone, volume }));
    } catch {
      /* Browser storage is optional. */
    }
  }, [mode, tone, volume]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    getStatus()
      .then((result) => {
        if (active) {
          setAvailable(result.available);
          setVoiceAvailable(result.voiceAvailable);
        }
      })
      .catch(() => {
        if (active) {
          setAvailable(false);
          setVoiceAvailable(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open, getStatus]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, busy]);

  const stopAudio = () => {
    speechRequestRef.current += 1;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setListening(false);
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setSpeaking(false);
  };
  const speak = async (words: string) => {
    if (mode !== "voice" || !voiceAvailable) return;
    const request = ++speechRequestRef.current;
    try {
      const result = await synthesize({ data: { text: words.slice(0, 900) } });
      if (request !== speechRequestRef.current) return;
      const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audio.volume = volume;
      audioRef.current = audio;
      audio.onended = () => {
        setSpeaking(false);
        URL.revokeObjectURL(url);
        audioUrlRef.current = null;
        audioRef.current = null;
      };
      audio.onerror = () => {
        setSpeaking(false);
        setError("ElevenLabs audio could not play. Read the text reply above.");
      };
      await audio.play();
      setSpeaking(true);
    } catch (cause) {
      if (request === speechRequestRef.current)
        setError(cause instanceof Error ? cause.message : "ElevenLabs audio failed. Read the text reply above.");
    }
  };
  const close = () => {
    stopAudio();
    setOpen(false);
  };

  const localReply = async (input: string): Promise<string | null> => {
    const phrase = input
      .toLowerCase()
      .trim()
      .replace(/[.!?]+$/, "");
    if (/^(status|what is the status|what's the status|give me a status update)$/.test(phrase)) {
      const facts = await dashboard();
      const queued = facts.jobs.filter((job) => !job.sent_at).length;
      return `I can see ${facts.projects.length} registered projects, ${queued} OMNI tasks queued but not sent, ${facts.reports.length} open reports, and ${facts.proposals.length} proposals. This is live workspace data; it does not mean an agent ran.`;
    }
    const match = phrase.match(
      /^(?:open|show|go to) (?:the )?(dashboard|projects|inspect|discovery|research|agents|fleet|automation|omni|logs|integrations|access)$/,
    );
    if (!match) return null;
    const routes = {
      dashboard: "/",
      projects: "/projects",
      inspect: "/workspace",
      discovery: "/discovery",
      research: "/research",
      agents: "/agents",
      fleet: "/fleet",
      automation: "/automation",
      omni: "/omni",
      logs: "/activity",
      integrations: "/integrations",
      access: "/access",
    } as const;
    navigate({ to: routes[match[1] as keyof typeof routes] });
    return `Opened ${match[1]}.`;
  };

  const sendMessage = async (raw: string) => {
    const content = raw.trim().slice(0, 1000);
    if (!content || busy) return;
    setDraft("");
    setError("");
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setBusy(true);
    try {
      const local = await localReply(content);
      if (local) {
        setMessages([...next, { role: "assistant", content: local }]);
        void speak(local);
      } else if (!available) {
        setError("AI conversation is not connected. Local status and navigation commands still work.");
      } else {
        const result = await chat({ data: { messages: next.slice(-12), tone } });
        setMessages([...next, { role: "assistant", content: result.answer }]);
        void speak(result.answer);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Chat failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const listen = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    if (mode !== "voice" || busy) return;
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) {
      setError("Speech recognition is unavailable in this browser. Use text chat.");
      return;
    }
    stopAudio();
    setError("");
    const recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event: any) => {
      const words = event.results?.[0]?.[0]?.transcript;
      if (words) void sendMessage(words);
    };
    recognition.onerror = (event: any) => {
      setListening(false);
      setError(`Microphone error: ${event.error || "unavailable"}. Use text chat.`);
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setError("Could not start the microphone. Use text chat.");
    }
  };

  return (
    <div className="fixed bottom-24 right-4 z-50 md:bottom-6 md:right-6">
      {open && (
        <section
          aria-label="Jackboy voice chat"
          className="mb-3 flex h-[min(72vh,620px)] w-[min(390px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        >
          <div className="flex items-center gap-3 border-b border-border bg-sidebar px-4 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-electric/15 text-electric">
              <Hex className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-foreground">Talk with Jackboy</h2>
              <p className="text-xs text-muted-foreground">
                {available === null
                  ? "Checking connections…"
                  : available
                    ? "AI chat configured · model test pending"
                    : "AI chat not connected · local commands work"}{" "}
                · {voiceAvailable ? "ElevenLabs voice ready to test" : "ElevenLabs voice not connected"}
              </p>
            </div>
            <button
              aria-label="Close voice chat"
              onClick={close}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex gap-1 border-b border-border px-3 py-2" role="group" aria-label="Chat mode">
            {(
              [
                ["voice", "Voice + Text"],
                ["text", "Text Only"],
                ["silent", "Silent"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={mode === value}
                onClick={() => {
                  stopAudio();
                  setMode(value);
                }}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs ${mode === value ? "bg-electric text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
            {messages.length === 0 && (
              <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Start a conversation</p>
                <p className="mt-2">
                  Ask Jackboy a question, or say “status” for live workspace counts and “open integrations” to navigate.
                </p>
                {!available && <p className="mt-2">Natural AI replies need an owner-enabled model connection.</p>}
              </div>
            )}
            {messages.map((message, index) => (
              <div
                key={index}
                className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${message.role === "user" ? "ml-auto bg-electric text-primary-foreground" : "border border-border bg-muted text-foreground"}`}
              >
                {message.content}
              </div>
            ))}
            {busy && <p className="text-xs text-muted-foreground">Jackboy checking…</p>}
            <div ref={endRef} />
          </div>
          {error && (
            <p
              role="alert"
              className="mx-3 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
          <div className="border-t border-border p-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <label htmlFor="jackboy-tone">Style</label>
              <select
                id="jackboy-tone"
                value={tone}
                onChange={(event) => setTone(event.target.value as Tone)}
                className="rounded border border-border bg-background px-2 py-1"
              >
                <option value="direct">Direct</option>
                <option value="balanced">Balanced</option>
                <option value="witty">Witty</option>
              </select>
              {mode === "voice" && (
                <>
                  <label htmlFor="jackboy-volume" className="ml-auto">
                    Volume
                  </label>
                  <input
                    id="jackboy-volume"
                    aria-label="Voice volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={volume}
                    onChange={(event) => setVolume(Number(event.target.value))}
                    className="w-20"
                  />
                </>
              )}
            </div>
            {mode === "voice" && !voiceAvailable && (
              <p className="mb-2 text-xs text-muted-foreground">
                Spoken replies need the original Jackboy ElevenLabs voice and server connection.
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage(draft);
              }}
              className="flex items-end gap-2"
            >
              <textarea
                aria-label="Message Jackboy"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage(draft);
                  }
                }}
                rows={2}
                maxLength={1000}
                placeholder="Message Jackboy…"
                className="min-h-12 max-h-28 flex-1 resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-electric"
              />
              {mode === "voice" && (
                <button
                  type="button"
                  onClick={listen}
                  disabled={busy}
                  aria-label={listening ? "Stop listening" : "Speak to Jackboy"}
                  className={`rounded-full p-3 ${listening ? "bg-destructive text-destructive-foreground" : "bg-muted text-foreground"}`}
                >
                  {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
              )}
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                aria-label="Send message"
                className="rounded-full bg-electric p-3 text-primary-foreground disabled:opacity-40"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </form>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <button
                onClick={stopAudio}
                disabled={!listening && !speaking}
                className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
              >
                <Square className="h-3 w-3" /> Stop audio
              </button>
              <button
                onClick={() => {
                  stopAudio();
                  setMessages([]);
                  setError("");
                }}
                className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
              >
                <Trash2 className="h-3 w-3" /> Clear chat
              </button>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
              Browser speech recognition may use its speech service. When enabled, conversation text goes to OpenAI and
              spoken replies go to ElevenLabs. This chat has no access to your Mac, agents, or passwords.
            </p>
          </div>
        </section>
      )}
      <button
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={open ? "Close Jackboy chat" : "Open Jackboy voice chat"}
        className="ml-auto flex h-14 w-14 items-center justify-center rounded-full border border-electric/50 bg-sidebar text-electric shadow-xl hover:bg-muted"
      >
        <Hex className="h-7 w-7" />
      </button>
    </div>
  );
}

function AccountNav() {
  const navigate = useNavigate();
  const { queryClient } = useRouteContext({ from: "__root__" });
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    const { data } = supabase.auth.onAuthStateChange((e, s) => {
      if (e === "SIGNED_IN" || e === "SIGNED_OUT" || e === "USER_UPDATED") setEmail(s?.user.email ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }
  const item = "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent";
  if (email === undefined) return <div className="mt-auto" />;
  if (!email) return (
    <div className="mt-auto flex flex-col gap-1 border-t border-sidebar-border p-3">
      <Link to="/auth" className={item}><LogIn className="h-4 w-4" aria-hidden /> Sign in</Link>
    </div>
  );
  return (
    <div className="mt-auto flex flex-col gap-1 border-t border-sidebar-border p-3" aria-label="Account">
      <p className="truncate px-3 text-[11px] text-muted-foreground" title={email}>{email}</p>
      <Link to="/account" className={item} activeProps={{ className: "bg-sidebar-accent" }}><UserRound className="h-4 w-4" aria-hidden /> Account</Link>
      <Link to="/security" className={item} activeProps={{ className: "bg-sidebar-accent" }}><ShieldCheck className="h-4 w-4" aria-hidden /> Security</Link>
      <button type="button" onClick={() => void signOut()} className={`${item} text-left`}><LogOut className="h-4 w-4" aria-hidden /> Sign out</button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (r) => r.location.pathname });
  // The conversation is a dedicated full-screen view without dashboard chrome.
  if (path === "/chat") return <>{children}</>;
  if (path === "/auth" || path === "/onboarding") {
    return (
      <div className="min-h-screen px-4 py-6">
        <div className="flex items-center justify-center gap-2">
          <Hex className="h-7 w-7 text-silver" />
          <span className="text-metal font-display text-xl font-bold tracking-wider">JACKBOY</span>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="flex items-center gap-2 px-5 py-5">
          <Hex className="h-7 w-7 text-silver" />
          <div>
            <div className="text-metal font-display text-xl font-bold tracking-wider">JACKBOY</div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">OMNI · Dev Ops</div>
          </div>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1 px-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === "/" }}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
              activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground border-l-2 border-electric" }}
            >
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </Link>
          ))}
        </nav>
        <AccountNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pb-20 md:pb-0">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b md:hidden border-border bg-background/85 px-4 py-3 backdrop-blur md:px-8">
          <div className="flex items-center gap-2 md:hidden">
            <Hex className="h-6 w-6 text-silver" />
            <span className="text-metal font-display text-lg font-bold tracking-wider">JACKBOY</span>
          </div>
        </header>
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>

      <nav
        aria-label="Main mobile"
        className="fixed inset-x-0 bottom-0 z-20 flex overflow-x-auto border-t border-border bg-sidebar md:hidden"
      >
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: to === "/" }}
            className="flex min-w-16 flex-1 flex-col items-center gap-1 py-2.5 text-[10px] text-muted-foreground"
            activeProps={{ className: "text-electric" }}
          >
            <Icon className="h-5 w-5" aria-hidden />
            <span className="truncate">{label.split(" ")[0]}</span>
          </Link>
        ))}
      </nav>
      {/* One conversation: a single unobtrusive bubble opens the full-screen chat (the old mini-chat panel is retired). */}
      <Link to="/chat" aria-label="Open chat with Jackboy" title="Chat with Jackboy"
        className="fixed bottom-20 right-4 z-30 flex size-14 items-center justify-center rounded-full border border-electric/50 bg-sidebar text-electric shadow-xl hover:bg-muted focus-visible:outline-2 focus-visible:outline-electric md:bottom-6 md:right-6">
        <Hex className="h-7 w-7" />
      </Link>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-silver md:text-3xl">{title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

export function GuidanceTip({ children }: { children: ReactNode }) {
  const { guidance } = useJackboy();
  if (!guidance) return null;
  return (
    <div
      role="note"
      className="mb-4 flex gap-2 rounded-md border border-electric/40 bg-accent/40 p-3 text-sm text-accent-foreground"
    >
      <Hex className="mt-0.5 h-4 w-4 shrink-0 text-electric" />
      <div>{children}</div>
    </div>
  );
}

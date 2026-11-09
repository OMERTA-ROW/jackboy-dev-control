import { createFileRoute, useNavigate, useRouteContext } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { listChatThreads } from "@/lib/chat-threads.functions";
import { ChatError } from "@/components/chat/ChatPage";

export const Route = createFileRoute("/_authenticated/chat/")({
  head: () => ({
    meta: [
      { title: "Chat with Jackboy" },
      { name: "description", content: "Talk or type with Jackboy about your projects and agents, with saved, searchable conversations." },
      { property: "og:title", content: "Chat with Jackboy" },
      { property: "og:description", content: "A private voice and text conversation with Jackboy." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ChatIndex,
  errorComponent: ChatError,
});

/** Opens the latest saved conversation for the current mode, or a fresh one. */
function ChatIndex() {
  const navigate = useNavigate();
  const { user } = useRouteContext({ from: "/_authenticated" });
  const [error, setError] = useState<string | null>(null);
  const list = useServerFn(listChatThreads);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // GitHub App setup returns here with ?github=…; hand it to the conversation page.
    try { if (window.location.search.includes("github=")) sessionStorage.setItem("jackboy.chat.banner", window.location.search); } catch { /* ignore */ }
    let mode = "chat";
    try { if (sessionStorage.getItem("jackboy.chat.view") === "code") mode = "code"; } catch { /* ignore */ }
    const go = (id: string) => void navigate({ to: "/chat/$threadId", params: { threadId: id }, replace: true });
    list().then((t) => {
      let last: string | null = null;
      try { last = localStorage.getItem(`jackboy.chat.last.${user.id}`); } catch { /* Account history remains available. */ }
      go(t.find((x) => x.id === last)?.id ?? t.find((x) => x.mode === mode)?.id ?? crypto.randomUUID());
    }).catch((e) => setError(`Couldn't restore conversations: ${(e as Error).message}`));
  }, [list, navigate, user.id]);
  if (error) return <div role="alert" className="p-6"><p>{error}</p><button type="button" onClick={() => window.location.reload()}>Retry</button></div>;
  return <p className="flex min-h-dvh items-center justify-center bg-background text-sm text-muted-foreground">Opening your conversation…</p>;
}

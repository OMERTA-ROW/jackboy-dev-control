import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatError, ChatPage } from "@/components/chat/ChatPage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  beforeLoad: ({ params }) => { if (!UUID.test(params.threadId)) throw redirect({ to: "/chat" }); },
  head: () => ({
    meta: [
      { title: "Conversation · Jackboy Chat" },
      { name: "description", content: "A saved private conversation with Jackboy." },
      { property: "og:title", content: "Conversation · Jackboy Chat" },
      { property: "og:description", content: "A saved private conversation with Jackboy." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ThreadPage,
  errorComponent: ChatError,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  // Keyed by conversation so messages, voice and attachments never bleed between conversations.
  return <ChatPage key={threadId} threadId={threadId} />;
}

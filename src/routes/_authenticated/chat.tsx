import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout for Jackboy Chat: /chat opens the latest conversation, /chat/<id> is one saved conversation.
export const Route = createFileRoute("/_authenticated/chat")({
  component: () => <Outlet />,
});

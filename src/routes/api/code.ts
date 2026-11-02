import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/code")({ server: { handlers: {
  GET: async ({ request }) => (await import("@/lib/code-api.server")).handleCode(request),
  POST: async ({ request }) => (await import("@/lib/code-api.server")).handleCode(request),
} } });

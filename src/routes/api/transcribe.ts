import { createFileRoute } from "@tanstack/react-router";

// Owner-only speech-to-text fallback for browsers without built-in speech recognition (e.g. some iPhone/iPad Safari setups).
// Audio is forwarded once for transcription and never stored by Jackboy.
const MAX_BYTES = 10 * 1024 * 1024;

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyOwner } = await import("@/lib/chat.server");
        const userId = await verifyOwner(request);
        if (!userId) return Response.json({ error: "Owner sign-in required." }, { status: 401 });
        const key = process.env["LOVABLE_API_KEY"];
        if (!key) return Response.json({ error: "Voice transcription is not configured on the server." }, { status: 500 });
        const form = await request.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File) || !file.size || file.size > MAX_BYTES || !file.type.startsWith("audio/"))
          return Response.json({ error: "Send one audio recording under 10 MB." }, { status: 400 });
        const out = new FormData();
        out.append("model", "openai/gpt-transcribe");
        out.append("file", file, file.name || "speech.webm");
        out.append("response_format", "json");
        const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "X-Lovable-AIG-SDK": "fetch" }, body: out, signal: request.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } | string; message?: string };
        if (!res.ok) {
          const msg = typeof body.error === "string" ? body.error : body.error?.message ?? body.message ?? "Transcription failed.";
          return Response.json({ error: res.status === 402 ? "AI credits are used up. Add credits to keep using voice." : msg }, { status: res.status });
        }
        return Response.json({ text: (body.text ?? "").trim() });
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { parseResult, verifyCallback } from "@/lib/omni-link";

// OMNI → Jackboy job results. Public route, so every request must carry a fresh HMAC signature over the raw body.
export const Route = createFileRoute("/api/public/omni/callback")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["OMNI_CALLBACK_SECRET"];
        if (!secret) return new Response("OMNI callback not configured", { status: 401 }); // refuse; never a server error
        const body = await request.text();
        if (body.length > 64_000) return new Response("too large", { status: 413 });
        const nonce = request.headers.get("x-omni-nonce");
        const bad = await verifyCallback(secret, { signature: request.headers.get("x-omni-signature"), timestamp: request.headers.get("x-omni-timestamp"), nonce }, body);
        if (bad) return new Response(bad, { status: 401 });
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { return new Response("bad json", { status: 400 }); }
        const r = parseResult(parsed);
        if (typeof r === "string") return new Response(r, { status: 400 });
        const { applyOmniResult } = await import("@/lib/omni-link.server");
        const out = await applyOmniResult(nonce!, r);
        return new Response(out.body, { status: out.status });
      },
    },
  },
});

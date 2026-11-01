import { createFileRoute } from "@tanstack/react-router";

// Public: Jackboy's Ed25519 public key (raw, base64) so projects can verify signed manifests and flags.
export const Route = createFileRoute("/api/public/updates/public-key")({
  server: {
    handlers: {
      OPTIONS: async () => { const { CORS } = await import("@/lib/update-server.server"); return new Response(null, { status: 204, headers: CORS }); },
      GET: async () => {
        const s = await import("@/lib/update-server.server");
        const k = await s.keys();
        if (!k) return s.json({ error: "signing_not_configured" }, 503);
        return s.json({ algorithm: "Ed25519", encoding: "base64-raw", public_key: k.publicKeyBase64, signed_format: "canonical JSON (sorted keys, no whitespace)" });
      },
    },
  },
});

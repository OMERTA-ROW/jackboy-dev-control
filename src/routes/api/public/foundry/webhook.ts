import { createFileRoute } from "@tanstack/react-router";

// GitHub push webhook → one budgeted Foundry inspection. Rejects everything unless the
// HMAC-SHA256 signature matches the FOUNDRY_WEBHOOK_SECRET backend secret.
async function verify(secret: string, body: string, sig: string | null) {
  if (!sig?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const got = sig.slice(7);
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/foundry/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["FOUNDRY_WEBHOOK_SECRET"];
        if (!secret) return Response.json({ error: "Webhook not configured" }, { status: 403 });
        const body = await request.text();
        if (body.length > 1_000_000) return Response.json({ error: "Too large" }, { status: 413 });
        if (!(await verify(secret, body, request.headers.get("x-hub-signature-256")))) return Response.json({ error: "Bad signature" }, { status: 401 });
        if (request.headers.get("x-github-event") !== "push") return Response.json({ ignored: true });
        let repo = "";
        try { repo = String((JSON.parse(body) as { repository?: { full_name?: string } }).repository?.full_name ?? ""); } catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return Response.json({ error: "No repository" }, { status: 400 });
        const { webhookInspect } = await import("@/lib/foundry.server");
        const r = await webhookInspect(repo);
        return Response.json({ ok: true, result: r });
      },
    },
  },
});

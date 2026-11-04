import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function requireOwner(ctx: { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> } }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can manage the OMNI link.");
}

export const getOmniLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { omniConfigState } = await import("./omni-link.server");
    const [conn, jobs] = await Promise.all([
      context.supabase.from("omni_connection").select("*").eq("id", true).maybeSingle(),
      context.supabase.from("omni_jobs").select("id, kind, status, repo, attempts, last_error, sent_at, completed_at, pr_url, created_at, code_request_id, instructions").order("created_at", { ascending: false }).limit(25),
    ]);
    return { config: omniConfigState(), connection: conn.data, jobs: (jobs.data ?? []).map((j) => ({ ...j, instructions: j.instructions.slice(0, 160) })) };
  });

export const runOmniHandshake = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { omniHandshake } = await import("./omni-link.server");
    return omniHandshake(context.userId);
  });

/** Non-mutating live proof for readiness checks; never sends work or stores credential-derived proof. */
export const probeOmniConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const url = process.env["OMNI_API_URL"], key = process.env["OMNI_API_KEY"], secret = process.env["OMNI_CALLBACK_SECRET"];
    if (!url || !key || !secret) return { verified: false, error: "Set OMNI_API_URL, OMNI_API_KEY and OMNI_CALLBACK_SECRET on Jackboy; matching keys must be configured on the hosted OMNI worker." };
    const { parseHandshake, hmacHex, safeEqual } = await import("./omni-link");
    const challenge = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    try {
      const endpoint = new URL(url);
      if (endpoint.protocol !== "https:") return { verified: false, error: "OMNI_API_URL must be an HTTPS worker origin." };
      const response = await fetch(`${url.replace(/\/$/, "")}/jackboy/handshake`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ challenge }) });
      if (!response.ok) return { verified: false, error: `OMNI handshake returned HTTP ${response.status}; check worker hosting and matching OMNI_API_KEY.` };
      const handshake = parseHandshake(await response.json());
      if (typeof handshake === "string") return { verified: false, error: "OMNI returned an unsupported handshake contract." };
      if (!safeEqual(handshake.proof, await hmacHex(secret, challenge))) return { verified: false, error: "OMNI callback proof failed; re-enter matching OMNI_CALLBACK_SECRET on both sides." };
      return { verified: true, version: handshake.version, capabilities: handshake.capabilities };
    } catch { return { verified: false, error: "OMNI handshake could not complete; check hosted HTTPS origin and /jackboy/handshake availability." }; }
  });

export const dispatchOmniNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { dispatchOmniJobs } = await import("./omni-link.server");
    return dispatchOmniJobs();
  });

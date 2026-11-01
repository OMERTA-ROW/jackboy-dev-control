import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { mayRequest, STEP_UP_ACTIONS } from "./step-up";

type Ctx = { supabase: any; userId: string };
async function role(ctx: Ctx): Promise<string | null> { const { data } = await ctx.supabase.rpc("my_role"); return (data as string) ?? null; }

export const listPasskeys = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { data } = await context.supabase.from("owner_passkeys").select("id, label, created_at, last_used_at").order("created_at");
  return { passkeys: data ?? [], actions: Object.entries(STEP_UP_ACTIONS).map(([id, a]) => ({ id, label: a.label, unavailable: "unavailable" in a ? a.unavailable : null })) };
});

export const passkeyRegisterOptions = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  if ((await role(context)) !== "owner") throw new Error("Owner only.");
  const { generateRegistrationOptions } = await import("@simplewebauthn/server");
  const s = await import("./passkey.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: existing } = await supabaseAdmin.from("owner_passkeys").select("credential_id, transports").eq("user_id", context.userId);
  const { rpID } = s.rp(getRequest());
  const opts = await generateRegistrationOptions({
    rpName: "Jackboy", rpID, userName: String((context as { claims?: { email?: string } }).claims?.email ?? context.userId),
    userID: new TextEncoder().encode(context.userId), attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: (existing ?? []).map((c) => ({ id: c.credential_id, transports: c.transports as never })),
  });
  return { challengeId: await s.saveChallenge(context.userId, opts.challenge, "register"), options: opts };
});

export const passkeyRegisterVerify = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ challengeId: z.string().uuid(), response: z.any(), label: z.string().max(60).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    if ((await role(context)) !== "owner") throw new Error("Owner only.");
    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    const s = await import("./passkey.server");
    const ch = await s.takeChallenge(data.challengeId, context.userId, "register");
    const { origin, rpID } = s.rp(getRequest());
    const v = await verifyRegistrationResponse({ response: data.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    if (!v.verified || !v.registrationInfo) throw new Error("Passkey could not be verified.");
    const c = v.registrationInfo.credential;
    const { isoBase64URL } = await import("@simplewebauthn/server/helpers");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("owner_passkeys").insert({ user_id: context.userId, credential_id: c.id, public_key: isoBase64URL.fromBuffer(c.publicKey), counter: c.counter, transports: c.transports ?? [], label: data.label || "Passkey" });
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("audit_logs").insert({ actor: context.userId, action: "passkey.registered", detail: { label: data.label ?? "Passkey" } as never, outcome: "ok" });
    return { ok: true };
  });

const scope = z.object({ action: z.string(), target: z.string().min(1).max(200) });

export const stepUpOptions = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => scope.parse(d))
  .handler(async ({ data, context }) => {
    const p = mayRequest(data.action, await role(context)); // permission first, independent of identity
    if (!p.ok) throw new Error(p.reason);
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const s = await import("./passkey.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: keys } = await supabaseAdmin.from("owner_passkeys").select("credential_id, transports").eq("user_id", context.userId);
    if (!keys?.length) throw new Error("No passkey registered. Add one in Settings → Security first.");
    const opts = await generateAuthenticationOptions({ rpID: s.rp(getRequest()).rpID, userVerification: "required", allowCredentials: keys.map((k) => ({ id: k.credential_id, transports: k.transports as never })) });
    return { challengeId: await s.saveChallenge(context.userId, opts.challenge, "stepup", data.action, data.target), options: opts };
  });

export const stepUpVerify = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ challengeId: z.string().uuid(), response: z.any() }).parse(d))
  .handler(async ({ data, context }) => {
    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    const { isoBase64URL } = await import("@simplewebauthn/server/helpers");
    const s = await import("./passkey.server");
    const ch = await s.takeChallenge(data.challengeId, context.userId, "stepup");
    const p = mayRequest(ch.action ?? "", await role(context)); // re-check permission at grant time
    if (!p.ok) throw new Error(p.reason);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: key } = await supabaseAdmin.from("owner_passkeys").select("*").eq("user_id", context.userId).eq("credential_id", data.response?.id ?? "").maybeSingle();
    if (!key) throw new Error("Unknown passkey for this account.");
    const { origin, rpID } = s.rp(getRequest());
    const v = await verifyAuthenticationResponse({ response: data.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: key.credential_id, publicKey: isoBase64URL.toBuffer(key.public_key), counter: Number(key.counter), transports: key.transports as never } });
    if (!v.verified) {
      await supabaseAdmin.from("audit_logs").insert({ actor: context.userId, action: "stepup.failed", detail: { action: ch.action, target: ch.target } as never, outcome: "denied" });
      throw new Error("Passkey check failed.");
    }
    await supabaseAdmin.from("owner_passkeys").update({ counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }).eq("id", key.id);
    const g = await s.issueGrant(context.userId, ch.action!, ch.target!, key.credential_id);
    return { grantId: g.id as string, expiresAt: g.expires_at as string };
  });

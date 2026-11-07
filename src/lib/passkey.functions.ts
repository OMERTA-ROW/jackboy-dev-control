import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { mayRequest, recentEligible, recentVerificationValid, STEP_UP_ACTIONS } from "./step-up";

type Ctx = { supabase: any; userId: string };
async function role(ctx: Ctx): Promise<string | null> { const { data } = await ctx.supabase.rpc("my_role"); return (data as string) ?? null; }
async function requireOwnerOrAdmin(ctx: Ctx) {
  const r = await role(ctx);
  if (r !== "owner" && r !== "admin") throw new Error("Owner or administrator only.");
  return r;
}

export const listPasskeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const currentRole = await requireOwnerOrAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("owner_passkeys")
      .select("id, label, created_at, last_used_at, rp_id")
      .eq("user_id", context.userId)
      .order("created_at");
    if (error) throw new Error(error.message);
    let host: string | null = null;
    let hostError: string | null = null;
    try {
      const s = await import("./passkey.server");
      host = s.rp(getRequest()).rpID;
    } catch (e) {
      hostError = (e as Error).message;
    }
    return {
      passkeys: data ?? [],
      host,
      hostError,
      canRemove: currentRole === "owner",
      actions: Object.entries(STEP_UP_ACTIONS).map(([id, a]) => ({
        id,
        label: a.label,
        unavailable: "unavailable" in a ? a.unavailable : null,
      })),
    };
  });

export const removePasskey = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), grantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    if ((await role(context)) !== "owner") throw new Error("Owner only.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const result = await supabaseAdmin.rpc("remove_owner_passkey", { _actor: context.userId, _key: data.id, _grant: data.grantId });
    if (result.error) throw new Error(result.error.message);
    return { removed: true };
  });

export const passkeyRegisterOptions = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
    await requireOwnerOrAdmin(context);
  const { generateRegistrationOptions } = await import("@simplewebauthn/server");
  const s = await import("./passkey.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: existing } = await supabaseAdmin.from("owner_passkeys").select("credential_id, transports").eq("user_id", context.userId).eq("rp_id", s.rp(getRequest()).rpID);
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
    await requireOwnerOrAdmin(context);
    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    const s = await import("./passkey.server");
    const ch = await s.takeChallenge(data.challengeId, context.userId, "register");
    const { origin, rpID } = s.rp(getRequest());
    const v = await verifyRegistrationResponse({ response: data.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    if (!v.verified || !v.registrationInfo) throw new Error("Passkey could not be verified.");
    const c = v.registrationInfo.credential;
    const { isoBase64URL } = await import("@simplewebauthn/server/helpers");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("owner_passkeys").insert({ user_id: context.userId, credential_id: c.id, public_key: isoBase64URL.fromBuffer(c.publicKey), counter: c.counter, transports: c.transports ?? [], label: data.label || "Passkey", rp_id: rpID });
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("audit_logs").insert({ actor: context.userId, action: "passkey.registered", detail: { label: data.label ?? "Passkey", site: rpID } as never, outcome: "ok" });
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
    const { rpID } = s.rp(getRequest());
    const { data: keys } = await supabaseAdmin.from("owner_passkeys").select("credential_id, transports, label").eq("user_id", context.userId).eq("rp_id", rpID);
    if (!keys?.length) throw new Error(`No passkey registered for ${rpID}. Add one in Settings → Security on this address first.`);
    const opts = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: keys.map((k) => ({ id: k.credential_id, transports: k.transports as never })) });
    // Labels + transports let the passkey window name the device's real method (Face ID, Windows Hello, 1Password…).
    return { challengeId: await s.saveChallenge(context.userId, opts.challenge, "stepup", data.action, data.target), options: opts, keys: keys.map((k) => ({ label: k.label as string | null, transports: (k.transports ?? []) as string[] })) };
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

/** Reuse a passkey check from the last 10 minutes for routine connection reviews only.
 * Mints a fresh single-use grant for the exact action+target; returns null when a new passkey check is needed. */
export const stepUpRecent = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => scope.parse(d))
  .handler(async ({ data, context }) => {
    if (!recentEligible(data.action, data.target)) return null;
    const p = mayRequest(data.action, await role(context));
    if (!p.ok) throw new Error(p.reason);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Only grants backed by a real device ceremony count; reused grants are tagged "recent:" and never extend the window.
    const { data: last } = await supabaseAdmin.from("step_up_grants").select("created_at, credential_id").eq("user_id", context.userId)
      .not("credential_id", "like", "recent:%").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!last) return null;
    const { data: key } = await supabaseAdmin.from("owner_passkeys").select("id").eq("user_id", context.userId).eq("credential_id", last.credential_id).maybeSingle();
    if (!recentVerificationValid(last, !!key)) return null;
    const s = await import("./passkey.server");
    const g = await s.issueGrant(context.userId, data.action, data.target, `recent:${last.credential_id}`);
    return { grantId: g.id as string, expiresAt: g.expires_at as string };
  });

/** Real sign-in check: asks the device for the passkey and verifies it, without granting any action. */
export const passkeyTestOptions = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
    await requireOwnerOrAdmin(context);
  const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
  const s = await import("./passkey.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { rpID } = s.rp(getRequest());
  const { data: keys } = await supabaseAdmin.from("owner_passkeys").select("credential_id, transports, label").eq("user_id", context.userId).eq("rp_id", rpID);
  if (!keys?.length) throw new Error(`No passkey registered for ${rpID} yet.`);
  const opts = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: keys.map((k) => ({ id: k.credential_id, transports: k.transports as never })) });
  return { challengeId: await s.saveChallenge(context.userId, opts.challenge, "stepup", "passkey.test", "self"), options: opts, keys: keys.map((k) => ({ label: k.label as string | null, transports: (k.transports ?? []) as string[] })) };
});

export const passkeyTestVerify = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ challengeId: z.string().uuid(), response: z.any() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwnerOrAdmin(context);
    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    const { isoBase64URL } = await import("@simplewebauthn/server/helpers");
    const s = await import("./passkey.server");
    const ch = await s.takeChallenge(data.challengeId, context.userId, "stepup");
    if (ch.action !== "passkey.test") throw new Error("Wrong passkey request.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { origin, rpID } = s.rp(getRequest());
    const { data: key } = await supabaseAdmin.from("owner_passkeys").select("*").eq("user_id", context.userId).eq("rp_id", rpID).eq("credential_id", data.response?.id ?? "").maybeSingle();
    if (!key) throw new Error("Unknown passkey for this account on this address.");
    const v = await verifyAuthenticationResponse({ response: data.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: key.credential_id, publicKey: isoBase64URL.toBuffer(key.public_key), counter: Number(key.counter), transports: key.transports as never } });
    if (!v.verified) throw new Error("Passkey check failed.");
    await supabaseAdmin.from("owner_passkeys").update({ counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }).eq("id", key.id);
    await supabaseAdmin.from("audit_logs").insert({ actor: context.userId, action: "passkey.tested", detail: { site: rpID } as never, outcome: "ok" });
    return { ok: true, label: key.label as string };
  });

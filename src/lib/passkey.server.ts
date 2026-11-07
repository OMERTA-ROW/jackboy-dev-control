// Server-only WebAuthn ceremonies and single-use step-up grants.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CHALLENGE_TTL_MS, GRANT_TTL_MS, grantUsable } from "./step-up";
import { passkeyOrigin } from "./passkey-origin";

export function rp(request: Request) {
  return passkeyOrigin(request.headers.get("origin") ?? new URL(request.url).origin);
}

export async function saveChallenge(userId: string, challenge: string, purpose: "register" | "stepup", action?: string, target?: string) {
  const { data, error } = await supabaseAdmin.from("webauthn_challenges").insert({ user_id: userId, challenge, purpose, action: action ?? null, target: target ?? null, expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString() }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/** Atomically use a challenge once (replay protection). */
export async function takeChallenge(id: string, userId: string, purpose: string) {
  const { data } = await supabaseAdmin.from("webauthn_challenges").update({ used_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", userId).eq("purpose", purpose).is("used_at", null).gt("expires_at", new Date().toISOString()).select("*").maybeSingle();
  if (!data) throw new Error("This passkey request expired or was already used. Try again.");
  return data;
}

export async function issueGrant(userId: string, action: string, target: string, credentialId: string) {
  const { data, error } = await supabaseAdmin.from("step_up_grants").insert({ user_id: userId, action, target, credential_id: credentialId, expires_at: new Date(Date.now() + GRANT_TTL_MS).toISOString() }).select("id, expires_at").single();
  if (error) throw new Error(error.message);
  await supabaseAdmin.from("audit_logs").insert({ actor: userId, action: "stepup.granted", detail: { action, target, grant: data.id } as never, outcome: "ok" });
  return data;
}

/** Consume a grant exactly once for this user/action/target. Throws if missing, used, expired or mismatched. */
export async function consumeGrant(grantId: string | undefined, userId: string, action: string, target: string, opts: { requireFresh?: boolean } = {}) {
  const deny = async (why: string) => {
    await supabaseAdmin.from("audit_logs").insert({ actor: userId, action: "stepup.denied", detail: { action, target, why } as never, outcome: "denied" });
    throw new Error(`Passkey confirmation required: ${why}`);
  };
  if (!grantId) return deny("no passkey confirmation for this action");
  const { data: g } = await supabaseAdmin.from("step_up_grants").select("*").eq("id", grantId).maybeSingle();
  if (!grantUsable(g, userId, action, target)) return deny("confirmation is missing, expired, used, or for a different action");
  if (opts.requireFresh && !grantIsFresh(g)) return deny("this action needs a new passkey check, not a recent one");
  const { data: used } = await supabaseAdmin.from("step_up_grants").update({ used_at: new Date().toISOString() }).eq("id", grantId).is("used_at", null).select("id").maybeSingle();
  if (!used) return deny("confirmation was already used");
}

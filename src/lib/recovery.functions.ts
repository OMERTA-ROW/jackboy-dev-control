import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { untyped } from "./untyped-db";
import {
  RECOVERY_WINDOW_MIN, canGenerateCodes, hashRecoveryCode, newRecoveryCodes, normalizeRecoveryCode, recoveryRateLimited,
} from "./recovery-codes";

// mfa_recovery_codes comes from drizzle/migrations/0039 (pending owner approval); calls fail clearly until applied.
const NOT_READY = "Recovery codes are not available yet: the owner has not approved the database update for them.";

async function admin() {
  return (await import("@/integrations/supabase/client.server")).supabaseAdmin;
}
async function audit(actor: string, action: string, outcome: string, detail: Record<string, unknown> = {}) {
  await (await admin()).from("audit_logs").insert({ actor, action, outcome, detail: detail as never });
}
/** Recovery activity is always recorded; owners also get an in-app security notification. */
async function notify(userId: string, role: unknown, message: string) {
  if (role === "owner") await (await admin()).from("owner_notifications").insert({ kind: "security", message });
  await audit(userId, "recovery.notify", "ok", { message });
}

export const recoveryStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await untyped(context.supabase).from("mfa_recovery_codes").select("used_at").eq("user_id", context.userId);
    if (error) return { ready: false as const, message: NOT_READY, total: 0, remaining: 0 };
    const rows = (data ?? []) as { used_at: string | null }[];
    return { ready: true as const, message: null, total: rows.length, remaining: rows.filter((r) => !r.used_at).length };
  });

/** Shown once. Requires an authenticator-verified session; replaces all previous codes. */
export const generateRecoveryCodes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    if (!canGenerateCodes((context.claims as { aal?: string }).aal)) {
      await audit(context.userId, "recovery.codes.generate", "denied", { reason: "aal1" });
      throw new Error("Verify with your authenticator code first (sign out and back in), then generate recovery codes.");
    }
    const sb = untyped(await admin());
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashRecoveryCode(context.userId, c)));
    const del = await sb.from("mfa_recovery_codes").delete().eq("user_id", context.userId);
    if (del.error) throw new Error(NOT_READY);
    const ins = await sb.from("mfa_recovery_codes").insert(hashes.map((code_hash) => ({ user_id: context.userId, code_hash })));
    if (ins.error) throw new Error("Could not save recovery codes. Nothing was changed on your sign-in.");
    const { data: role } = await context.supabase.rpc("my_role");
    await notify(context.userId, role, "New account recovery codes were generated; old codes no longer work.");
    return { codes };
  });

/**
 * Lost authenticator: after a correct password (aal1 session), one unused code removes the
 * authenticator so the user can sign in and re-enroll. It never changes roles, passkeys or
 * passkey grants, and signs out every other device.
 */
export const redeemRecoveryCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { code: string }) => ({ code: String(d?.code ?? "").slice(0, 40) }))
  .handler(async ({ data, context }) => {
    const sb = await admin();
    const since = new Date(Date.now() - RECOVERY_WINDOW_MIN * 60_000).toISOString();
    const { count } = await sb.from("audit_logs").select("id", { count: "exact", head: true })
      .eq("actor", context.userId).eq("action", "recovery.code.redeem").eq("outcome", "failed").gte("at", since);
    if (recoveryRateLimited(count ?? 0)) {
      await audit(context.userId, "recovery.code.redeem", "rate_limited");
      throw new Error(`Too many attempts. Wait ${RECOVERY_WINDOW_MIN} minutes and try again.`);
    }
    const fail = async () => { await audit(context.userId, "recovery.code.redeem", "failed"); throw new Error("That recovery code is not valid or was already used."); };
    if (!normalizeRecoveryCode(data.code)) return fail();
    const hash = await hashRecoveryCode(context.userId, data.code);
    // Conditional update = single use even under concurrent requests.
    const { data: used, error } = await untyped(sb).from("mfa_recovery_codes")
      .update({ used_at: new Date().toISOString() }).eq("user_id", context.userId).eq("code_hash", hash).is("used_at", null).select("id");
    if (error) throw new Error(NOT_READY);
    if (!used?.length) return fail();
    const { data: factors } = await sb.auth.admin.mfa.listFactors({ userId: context.userId });
    for (const f of factors?.factors ?? []) await sb.auth.admin.mfa.deleteFactor({ userId: context.userId, id: f.id });
    const jwt = getRequest().headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (jwt) await sb.auth.admin.signOut(jwt, "others");
    await audit(context.userId, "recovery.code.redeem", "ok", { factorsRemoved: factors?.factors?.length ?? 0 });
    const { data: role } = await context.supabase.rpc("my_role");
    await notify(context.userId, role, "A recovery code was used: your authenticator was removed and other devices were signed out. If this wasn't you, reset your password now.");
    return { ok: true };
  });

/** Records user-initiated recovery events (password reset, sign out other devices) for the activity trail. */
export const recordRecoveryEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { kind: "password_reset" | "sessions_revoked" }) => ({ kind: d?.kind === "password_reset" ? "password_reset" as const : "sessions_revoked" as const }))
  .handler(async ({ data, context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    await notify(context.userId, role, data.kind === "password_reset" ? "Your password was reset from a recovery link." : "All other devices were signed out of your account.");
    return { ok: true };
  });

export const recentSecurityActivity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (await admin()).from("audit_logs").select("action,outcome,at")
      .eq("actor", context.userId).like("action", "recovery.%").order("at", { ascending: false }).limit(10);
    return data ?? [];
  });

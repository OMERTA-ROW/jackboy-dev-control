import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { INVITE_TTL_DAYS, hashToken, inviteRedeemable, isWellFormedToken, newInviteToken } from "./invite-token";
import { OWNER_SETUP_REQUIRED, ownerSetupEligible, sendVerificationEmail } from "./account-auth";

async function admin() {
  return (await import("@/integrations/supabase/client.server")).supabaseAdmin;
}
function origin() {
  const req = getRequest();
  return new URL(req.url).origin;
}
async function auditAs(actor: string | null, action: string, outcome: string, detail: Record<string, unknown> = {}) {
  await (await admin()).from("audit_logs").insert({ actor, action, outcome, detail: detail as never });
}
async function ownerExists() {
  const { count, error } = await (await admin()).from("user_roles").select("id", { count: "exact", head: true }).eq("role", "owner");
  if (error) throw new Error("Could not check owner setup. Try again later.");
  return (count ?? 0) > 0;
}
async function recentAttempts(action: string, minutes: number) {
  const { count } = await (await admin()).from("audit_logs").select("id", { count: "exact", head: true })
    .eq("action", action).gte("at", new Date(Date.now() - minutes * 60_000).toISOString());
  return count ?? 0;
}

/** Public: whether owner setup is still possible. Never reveals the owner email. */
export const getSetupState = createServerFn({ method: "GET" }).handler(async () => ({
  ownerConfigured: Boolean(process.env["OWNER_EMAIL"]?.trim()),
  ownerExists: await ownerExists(),
}));

/**
 * Public owner bootstrap step 1: sends a verification email only if the address matches the
 * OWNER_EMAIL server secret and no owner exists. The response is identical either way.
 */
export const requestOwnerSetup = createServerFn({ method: "POST" })
  .inputValidator((d: { email: string }) => ({ email: String(d.email ?? "").trim().toLowerCase().slice(0, 254) }))
  .handler(async ({ data }) => {
    const generic = { message: "Request processed. If eligible, check your inbox and spam folder for the owner verification link. Jackboy cannot confirm inbox delivery; access still requires email verification and an explicit owner claim." };
    const ownerEmail = process.env["OWNER_EMAIL"]?.trim().toLowerCase();
    if (!ownerEmail) throw new Error(OWNER_SETUP_REQUIRED);
    if ((await recentAttempts("owner.setup_request", 60)) >= 10) throw new Error("Too many attempts. Try again later.");
    const match = ownerSetupEligible(ownerEmail, data.email, await ownerExists());
    await auditAs(null, "owner.setup_request", match ? "requested" : "ignored");
    if (match) {
      const sb = await admin();
      try {
        await sendVerificationEmail(sb.auth, ownerEmail, `${origin()}/set-password`);
        await auditAs(null, "owner.setup_email", "accepted");
      } catch (error) {
        await auditAs(null, "owner.setup_email", "failed");
        throw error;
      }
    }
    return generic;
  });

/** Signed-in account status. */
export const getAccountStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    return { role: (role as string | null) ?? null, ownerConfigured: Boolean(process.env["OWNER_EMAIL"]), ownerExists: await ownerExists() };
  });

/** Owner bootstrap step 2: explicit claim by a verified account whose email matches the secret. */
export const claimOwner = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ownerEmail = process.env["OWNER_EMAIL"]?.trim().toLowerCase();
    if (!ownerEmail) throw new Error(OWNER_SETUP_REQUIRED);
    const sb = await admin();
    const { data: u } = await sb.auth.admin.getUserById(context.userId);
    if (!u.user?.email_confirmed_at || u.user.email?.toLowerCase() !== ownerEmail) {
      await auditAs(context.userId, "owner.claim", "denied");
      throw new Error("This account is not the configured, verified owner.");
    }
    if (await ownerExists()) {
      await auditAs(context.userId, "owner.claim", "denied");
      throw new Error("An owner already exists.");
    }
    const { error } = await sb.from("user_roles").insert({ user_id: context.userId, role: "owner" });
    if (error) throw new Error("Could not assign owner role.");
    await auditAs(context.userId, "owner.claim", "ok");
    return { role: "owner" };
  });

/** Owner/admin creates an invitation. Returns the raw token link exactly once; only its hash is stored. */
export const createInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email: string; role: "member" | "admin" }) => ({
    email: String(d.email ?? "").trim().toLowerCase(),
    role: d.role === "admin" ? ("admin" as const) : ("member" as const),
  }))
  .handler(async ({ data, context }) => {
    const { data: myRole } = await context.supabase.rpc("my_role");
    if (myRole !== "owner" && myRole !== "admin") throw new Error("Only the owner or an admin can invite.");
    if (data.role === "admin" && myRole !== "owner") throw new Error("Only the owner can invite admins.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) throw new Error("Invalid email.");
    const sb = await admin();
    await sb.from("invitations").update({ status: "revoked" }).eq("email", data.email).eq("status", "pending");
    const token = newInviteToken();
    const { error } = await sb.from("invitations").insert({
      email: data.email, role: data.role, invited_by: context.userId, token_hash: await hashToken(token),
      expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString(),
    });
    if (error) throw new Error("Could not create invitation.");
    await auditAs(context.userId, "invite.create", "ok", { email: data.email, role: data.role });
    return { link: `${origin()}/invite?token=${token}`, expiresInDays: INVITE_TTL_DAYS };
  });

async function loadInvite(token: string) {
  const { data } = await (await admin()).from("invitations").select("id,email,role,status,expires_at,used_at").eq("token_hash", await hashToken(token)).maybeSingle();
  return data;
}

/** Public: show which email an invite is for (masked) and whether it is still valid. */
export const inspectInvite = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data }) => {
    if (!isWellFormedToken(data.token)) return { ok: false as const, reason: "This invitation link is invalid." };
    const row = await loadInvite(data.token);
    const check = inviteRedeemable(row);
    if (!check.ok) return { ok: false as const, reason: check.reason };
    const [name, domain] = row!.email.split("@");
    return { ok: true as const, email: `${name!.slice(0, 2)}***@${domain}`, role: row!.role };
  });

/**
 * Public: redeem a single-use token. Marks it used atomically, then sends a verification email
 * (account invite) to the invited address. The role is bound to that account; sign-in still
 * requires the user to verify the email and set a password.
 */
export const redeemInvite = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data }) => {
    if (!isWellFormedToken(data.token)) throw new Error("This invitation link is invalid.");
    if ((await recentAttempts("invite.redeem", 10)) >= 30) throw new Error("Too many attempts. Try again later.");
    const sb = await admin();
    const row = await loadInvite(data.token);
    const check = inviteRedeemable(row);
    if (!check.ok) { await auditAs(null, "invite.redeem", "denied", { reason: check.reason }); throw new Error(check.reason); }
    // Atomic single-use: only one request can flip pending → accepted.
    const { data: claimed } = await sb.from("invitations").update({ status: "accepted", used_at: new Date().toISOString() })
      .eq("id", row!.id).eq("status", "pending").is("used_at", null).select("id").maybeSingle();
    if (!claimed) throw new Error("This invitation has already been used.");

    let userId: string | undefined;
    const inv = await sb.auth.admin.inviteUserByEmail(row!.email, { redirectTo: `${origin()}/set-password` });
    if (inv.data.user) userId = inv.data.user.id;
    else {
      // Account already exists: find it and send a password-reset style verification instead.
      const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
      userId = list.users.find((u) => u.email?.toLowerCase() === row!.email)?.id;
      if (userId) await sb.auth.resetPasswordForEmail(row!.email, { redirectTo: `${origin()}/set-password` });
    }
    if (!userId) {
      await sb.from("invitations").update({ status: "pending", used_at: null }).eq("id", row!.id);
      throw new Error("Could not send the verification email. Ask the owner for a new invitation.");
    }
    const { data: existing } = await sb.from("user_roles").select("role").eq("user_id", userId).maybeSingle();
    if (!existing) await sb.from("user_roles").insert({ user_id: userId, role: row!.role });
    await sb.from("invitations").update({ accepted_by: userId }).eq("id", row!.id);
    await auditAs(userId, "invite.redeem", "ok", { email: row!.email, role: row!.role });
    return { message: "Check your email inbox and open the verification link to set your password." };
  });

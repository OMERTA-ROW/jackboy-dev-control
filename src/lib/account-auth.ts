type AuthError = { message: string; code?: string | undefined };
export const OWNER_SETUP_REQUIRED = "Owner identity is not configured. In Project Settings → Secrets, add OWNER_EMAIL with your own email address, then return to First-time owner setup. This is not an email-provider credential.";

export function authErrorMessage(error: AuthError): string {
  if (/email.*not configured|smtp|email.*provider|sending.*email|send.*email|email.*send|email.*disabled/i.test(error.message) || error.code === "email_provider_disabled") {
    return "Email delivery is unavailable. Open More → Users → Auth settings → Email and confirm email sign-in is enabled. Check More → Emails for sending errors; if a custom sender is configured, complete its domain verification there. No verification email was confirmed sent. Do not disable email verification.";
  }
  return error.message;
}

export function ownerSetupEligible(configuredEmail: string | undefined, enteredEmail: string, ownerExists: boolean): boolean {
  const normalized = configuredEmail?.trim().toLowerCase();
  if (!normalized) throw new Error(OWNER_SETUP_REQUIRED);
  return !ownerExists && normalized === enteredEmail.trim().toLowerCase();
}

type MailAuth = {
  admin: { inviteUserByEmail: (email: string, options: { redirectTo: string }) => Promise<{ error: AuthError | null }> };
  resetPasswordForEmail: (email: string, options: { redirectTo: string }) => Promise<{ error: AuthError | null }>;
};

/** Only the configured Auth sender is used. Neither acceptance nor delivery is invented. */
export async function sendVerificationEmail(auth: MailAuth, email: string, redirectTo: string): Promise<void> {
  const invitation = await auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!invitation.error) return;
  if (invitation.error.code !== "email_exists" && invitation.error.code !== "user_already_exists" && !/already.*registered|already.*exists/i.test(invitation.error.message)) {
    throw new Error(authErrorMessage(invitation.error));
  }
  const recovery = await auth.resetPasswordForEmail(email, { redirectTo });
  if (recovery.error) throw new Error(authErrorMessage(recovery.error));
}

type SignInAuth = {
  signInWithPassword: (credentials: { email: string; password: string }) => Promise<{ error: AuthError | null }>;
  getUser: () => Promise<{ data: { user: { email_confirmed_at?: string | null | undefined } | null }; error: AuthError | null }>;
  signOut: () => Promise<unknown>;
};

/** Password sign-in is independent of OWNER_EMAIL; onboarding alone may claim ownership. */
export async function signInVerified(auth: SignInAuth, email: string, password: string): Promise<void> {
  const result = await auth.signInWithPassword({ email: email.trim(), password });
  if (result.error) throw new Error(authErrorMessage(result.error));
  const verified = await auth.getUser();
  if (verified.error || !verified.data.user?.email_confirmed_at) {
    await auth.signOut();
    throw new Error("Sign-in could not be verified. Confirm your email before accessing Jackboy.");
  }
}
/** Self-signup never grants a role: roles come only from claimOwner (OWNER_EMAIL) or accept_invitation. */
export function signupErrorMessage(error: AuthError): string {
  if (/signups? not allowed|signup.*disabled/i.test(error.message) || error.code === "signup_disabled") {
    return "Registration is invitation-only. Ask the owner for an invitation link, or sign in if you already have an account.";
  }
  if (/rate limit|too many/i.test(error.message) || error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit") {
    return "Too many attempts. Wait a few minutes before trying again.";
  }
  if (/password/i.test(error.message) && /weak|pwned|short|least/i.test(error.message)) {
    return `Choose a stronger password: ${error.message}`;
  }
  return authErrorMessage(error);
}

export type Aal = { currentLevel: string | null; nextLevel: string | null };
/** A verified TOTP factor raises nextLevel to aal2; the session must step up before use. */
export function mfaChallengeRequired(aal: Aal | null | undefined): boolean {
  return aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2";
}

export const AUTH_EMAIL_COOLDOWN_MS = 60_000;
export function cooldownRemaining(lastSentAt: number | null, now: number): number {
  if (!lastSentAt) return 0;
  return Math.max(0, Math.ceil((lastSentAt + AUTH_EMAIL_COOLDOWN_MS - now) / 1000));
}

export function passwordProblem(pw: string, confirm?: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (confirm !== undefined && pw !== confirm) return "Passwords do not match.";
  return null;
}

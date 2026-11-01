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
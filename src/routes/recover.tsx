import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/recover")({
  head: () => ({
    meta: [
      { title: "Account recovery — Jackboy" },
      { name: "description", content: "How to regain access to your Jackboy account after losing a password, authenticator, passkey or sign-in provider." },
      { property: "og:title", content: "Account recovery — Jackboy" },
      { property: "og:description", content: "Secure recovery options for Jackboy accounts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Recover,
});

const steps: { h: string; body: React.ReactNode }[] = [
  { h: "Forgot your password", body: <>On the sign-in page choose <strong>Forgot password?</strong> and enter your email. If an account exists, a single-use link that expires is sent to your verified email. The page always shows the same message so nobody can find out which emails have accounts.</> },
  { h: "Lost your authenticator app or phone", body: <>Sign in with your password. When asked for a 6-digit code, choose <strong>Use a recovery code</strong> and enter one of the codes you saved when you set up the authenticator. Each code works once. This removes the old authenticator and signs out all other devices; set up a new one right away under Security.</> },
  { h: "Lost your passkey device", body: <>Passkeys only confirm sensitive actions (merges, reverts, permission changes). Sign in normally, open Settings, remove the lost device and register a new passkey. Recovery never skips a passkey check; those actions stay locked until a new passkey is registered.</> },
  { h: "Lost access to Google or Microsoft sign-in", body: <>Use <strong>Forgot password?</strong> with the same email to set a password. Accounts are never joined just because another sign-in shares an email address; only verified emails link.</> },
  { h: "Lost both your authenticator and your recovery codes", body: <>This can't be done yourself, so nobody can take over an account by claiming to be you. Members: ask the owner to remove your account access, then accept a new invitation. Owner: see below.</> },
];

function Recover() {
  return (
    <section className="panel mx-auto mt-10 max-w-xl space-y-5 p-6" aria-labelledby="rec-h">
      <h1 id="rec-h" className="text-xl font-semibold text-silver">Account recovery</h1>
      {steps.map((s) => (
        <div key={s.h}><h2 className="text-sm font-semibold text-silver">{s.h}</h2><p className="mt-1 text-sm text-muted-foreground">{s.body}</p></div>
      ))}
      <div className="rounded-md border border-warning/40 p-4">
        <h2 className="text-sm font-semibold text-warning">Owner account: manual recovery</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Prove control of the owner email inbox by completing a password reset link.</li>
          <li>Prove control of this app's project in Lovable (only the project owner can view the Users area and server settings).</li>
          <li>From that project, remove the lost authenticator for your account under Users, then sign in and set up a new authenticator, new recovery codes and a new passkey.</li>
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">Recovery never creates or changes the owner role. Owner access stays tied to the configured owner email.</p>
      </div>
      <Link to="/auth" className="text-sm text-electric underline">Back to sign in</Link>
    </section>
  );
}

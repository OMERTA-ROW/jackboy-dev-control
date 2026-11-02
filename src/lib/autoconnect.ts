// AutoConnect pure rules (tested in autoconnect.test.ts). Approval never equals access:
// only a successful real verification call can make a capability "connected".

export type CapStatus = "missing" | "needs_approval" | "awaiting_setup" | "connected" | "expired" | "revoked" | "unavailable" | "error";
export type Capability = {
  id: string; name: string; method: string; scopes: string; manual: boolean;
  setupUrl: string | null; steps: string[]; verifiable: boolean;
};

export const CAPABILITIES: Capability[] = [
  { id: "github_actions_read", name: "GitHub Actions results (read)", method: "Fine-grained GitHub token, edited by you on GitHub", scopes: "Repository permission “Actions: Read-only” on this project's repo only", manual: true,
    setupUrl: "https://github.com/settings/personal-access-tokens", verifiable: true,
    steps: ["Open GitHub → Fine-grained tokens and edit the token Jackboy already uses.", "Under Repository permissions set “Actions” to Read-only. Leave everything else unchanged.", "Save. If GitHub issues a new token value, replace GITHUB_TOKEN in Project Settings → Secrets (never paste it in chat).", "Come back and press “Verify now”."] },
  { id: "github_repo", name: "GitHub repository (branches + draft PRs)", method: "Fine-grained GitHub token", scopes: "Contents: Read & write, Pull requests: Read & write — private repos only", manual: true,
    setupUrl: "https://github.com/settings/personal-access-tokens", verifiable: true,
    steps: ["Give the token access to this repo with Contents and Pull requests read & write.", "GitHub shows the secret token value only once. Its name (for example Jackboy code access) is not the secret.", "Save the secret value in the Jackboy Lovable project's backend Secrets as GITHUB_TOKEN, not GITHUB_KEY. Never put it in chat.", "Return to Blocker Queue to approve with a passkey and check access, or press Verify now if already approved."] },
  { id: "model_provider", name: "AI model", method: "Built-in Lovable AI (no key needed)", scopes: "Text generation for this app", manual: false, setupUrl: null, verifiable: true, steps: ["Nothing to set up; press “Verify now”."] },
  { id: "browser_runner", name: "Browser test runner", method: "No supported adapter yet", scopes: "-", manual: true, setupUrl: null, verifiable: false, steps: ["Not available: no isolated browser runner can be connected yet."] },
  { id: "deploy_api", name: "Deployment", method: "No supported adapter yet", scopes: "-", manual: true, setupUrl: null, verifiable: false, steps: ["Not available: Jackboy stops at draft PRs."] },
  { id: "notion", name: "Notion notes", method: "Workspace connector (OAuth)", scopes: "Pages you share with the integration", manual: true, setupUrl: null, verifiable: false, steps: ["Not available yet: note sync isn't built."] },
];

export const capById = (id: string) => CAPABILITIES.find((c) => c.id === id) ?? null;

/** Owner approval only moves a capability to "awaiting_setup"; it never grants access. */
export function afterApproval(cap: Capability): CapStatus {
  return cap.verifiable ? "awaiting_setup" : "unavailable";
}

/** The only path to "connected" is a passing verification that is not expired. */
export function afterVerify(ok: boolean, expiresAt: string | null, now = Date.now()): CapStatus {
  if (!ok) return "error";
  if (expiresAt && new Date(expiresAt).getTime() <= now) return "expired";
  return "connected";
}

export function effectiveStatus(g: { status: CapStatus; expires_at: string | null }, now = Date.now()): CapStatus {
  if (g.status === "connected" && g.expires_at && new Date(g.expires_at).getTime() <= now) return "expired";
  return g.status;
}

export type Bucket = "Connected" | "Needs Approval" | "Missing/Blocked";
export function bucket(s: CapStatus): Bucket {
  if (s === "connected") return "Connected";
  if (s === "missing" || s === "needs_approval") return "Needs Approval";
  return "Missing/Blocked";
}

export const MAX_VERIFY_ATTEMPTS = 10;
export function canVerify(g: { paused: boolean; verify_attempts: number; status: CapStatus }): string | null {
  if (g.paused) return "Paused.";
  if (g.status === "revoked") return "Revoked; approve again first.";
  if (g.status === "missing" || g.status === "needs_approval") return "Approve first.";
  if (g.verify_attempts >= MAX_VERIFY_ATTEMPTS) return "Too many failed checks; approve again to reset.";
  return null;
}

/** Maps a not-runnable test reason to the capability that would fix it. */
export function capabilityForTestGap(reason: string): string | null {
  if (/Actions: read|actions\/runs|Resource not accessible/i.test(reason)) return "github_actions_read";
  if (/sandbox runner|browser runner/i.test(reason)) return "browser_runner";
  return null;
}


// Pure GitHub App Manifest rules (tested in github-app-manifest.test.ts). No network, no secrets.
// The manifest is what GitHub pre-fills when the owner clicks "Create Jackboy GitHub App".

/** Least privilege. Each entry explains why; anything not listed is deliberately NOT requested. */
export const MANIFEST_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  actions: "read",
  checks: "read",
} as const;

export const PERMISSION_REASONS: { name: string; level: string; why: string; requested: boolean }[] = [
  { name: "Metadata", level: "Read-only", why: "Required by GitHub for every app: see repo names and basic info.", requested: true },
  { name: "Contents", level: "Read & write", why: "Read code and push fixes to separate jackboy/* branches. Never main without your approval.", requested: true },
  { name: "Pull requests", level: "Read & write", why: "Open draft pull requests so you can review every change.", requested: true },
  { name: "Actions", level: "Read-only", why: "Read test/CI results. Cannot start, change or delete workflows.", requested: true },
  { name: "Checks", level: "Read-only", why: "See pass/fail status on each pull request.", requested: true },
  { name: "Workflows", level: "Not requested", why: "Only needed to edit .github/workflows files. Can be added later if you approve a CI change.", requested: false },
  { name: "Packages", level: "Not requested", why: "Jackboy doesn't publish packages.", requested: false },
  { name: "Administration", level: "Not requested", why: "Would allow changing repo settings and access. Too powerful; never needed.", requested: false },
];

export const MANIFEST_EVENTS = ["pull_request", "check_run"] as const;

export function buildManifest(origin: string, org: string) {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) throw new Error("Jackboy address must be https.");
  return {
    name: `Jackboy ${org}`.slice(0, 34),
    url: origin,
    description: "Jackboy Dev Control: scoped branch edits and draft pull requests. Owner approves merges.",
    hook_attributes: { url: `${origin}/api/public/github/webhook`, active: true },
    redirect_url: `${origin}/api/public/github/manifest`,
    setup_url: `${origin}/api/public/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: { ...MANIFEST_PERMISSIONS },
    default_events: [...MANIFEST_EVENTS],
  };
}

export function manifestPostUrl(org: string, state: string) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new Error("Invalid GitHub organization name.");
  return `https://github.com/organizations/${org}/settings/apps/new?state=${encodeURIComponent(state)}`;
}

/** Constant-time check of GitHub's X-Hub-Signature-256 header. */
export async function verifyWebhookSignature(body: string, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  const want = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.slice(7);
  if (got.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}

/** AES-GCM with a key derived from GITHUB_APP_ENCRYPTION_KEY. Output: base64(iv).base64(ciphertext). */
async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`github-app:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function encryptText(plain: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), new TextEncoder().encode(plain)));
  return `${b64(iv)}.${b64(ct)}`;
}
export async function decryptText(enc: string, secret: string) {
  const [iv, ct] = enc.split(".");
  if (!iv || !ct) throw new Error("Stored credential is malformed.");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(secret), unb64(ct)));
}

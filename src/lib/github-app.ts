// Pure GitHub App rules (tested in github-app.test.ts): least-privilege permission set, official URLs,
// signed one-time install state, and PKCS#1 → PKCS#8 key wrapping for WebCrypto. No network, no secrets.

export type Level = "read" | "write";
/** Least privilege Jackboy asks for. Actions is read-only and only for CI results. */
export const NEEDED: Record<string, Level> = { metadata: "read", contents: "write", pull_requests: "write", actions: "read" };
export const LABEL: Record<string, string> = { metadata: "Metadata: Read-only", contents: "Contents: Read & write", pull_requests: "Pull requests: Read & write", actions: "Actions: Read-only" };

/** Returns human labels for each needed permission the installation does not grant at the required level. */
export function missingPermissions(granted: Record<string, string> | null | undefined, needed: Record<string, Level> = NEEDED): string[] {
  const g = granted ?? {};
  return Object.entries(needed).filter(([k, lvl]) => !(g[k] === "write" || (lvl === "read" && g[k] === "read"))).map(([k]) => LABEL[k] ?? k);
}

const ORG_RE = /^[A-Za-z0-9-]{1,39}$/;
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/** Official GitHub "register a GitHub App" page, pre-filled with only the needed permissions. Owner still reviews and creates it. */
export function appRegistrationUrl(org: string, origin: string): string {
  if (!ORG_RE.test(org)) throw new Error("Invalid GitHub organization name.");
  const q = new URLSearchParams({
    name: `Jackboy ${org}`.slice(0, 34), description: "Jackboy Dev Control: scoped branch edits and draft pull requests. Owner approves merges.",
    url: origin, setup_url: `${origin}/api/public/github/setup`, setup_on_update: "true", public: "false",
    webhook_active: "false", metadata: "read", contents: "write", pull_requests: "write", actions: "read",
  });
  return `https://github.com/organizations/${org}/settings/apps/new?${q.toString()}`;
}

export function installUrl(slug: string, state: string): string {
  if (!SLUG_RE.test(slug)) throw new Error("Invalid GitHub App slug.");
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
}

export type InstallState = { u: string; p: string | null; exp: number; n: string };

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function hmac(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(`github-install:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

export async function signState(s: Omit<InstallState, "n">, secret: string): Promise<string> {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ ...s, n: b64u(crypto.getRandomValues(new Uint8Array(9))) })));
  return `${body}.${b64u(await hmac(secret, body))}`;
}

/** Constant-time signature check plus expiry. Returns null when tampered, malformed or expired. */
export async function verifyState(token: string, secret: string, now = Date.now()): Promise<InstallState | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = await hmac(secret, body);
  let got: Uint8Array;
  try { got = unb64u(sig); } catch { return null; }
  if (got.length !== want.length) return null;
  let diff = 0; for (let i = 0; i < want.length; i++) diff |= want[i]! ^ got[i]!;
  if (diff) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64u(body))) as InstallState;
    return typeof s.u === "string" && typeof s.exp === "number" && s.exp > now ? s : null;
  } catch { return null; }
}

/** GitHub issues RSA keys as PKCS#1; WebCrypto imports PKCS#8. Wraps the DER in the PKCS#8 envelope. */
export function pemToPkcs8(pem: string): Uint8Array {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\\n|\s/g, "")), (c) => c.charCodeAt(0));
  if (!isPkcs1) return der;
  const len = (n: number) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...len(der.length)];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  return new Uint8Array([0x30, ...len(inner.length + der.length), ...inner, ...der]);
}

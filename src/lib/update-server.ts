// Pure update-server rules: versions, staged rollout buckets, rollback thresholds and Ed25519 signing.
export const CHANNELS = ["test", "beta", "live"] as const;
export type Channel = (typeof CHANNELS)[number];
export const RELEASE_STATUSES = ["draft", "rolling", "paused", "complete", "rolled_back"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre = ""] = v.split("+")[0]!.split(/-(.*)/s);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // release > prerelease
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Stable 0-99 bucket for a device within a release/flag, so a device stays in or out as the percent grows. */
export function rolloutBucket(device: string, salt: string): number {
  let h = 2166136261;
  const s = `${salt}:${device}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100;
}
export const inRollout = (device: string, salt: string, percent: number) => rolloutBucket(device, salt) < percent;

export type CandidateRelease = { id: string; version: string; status: ReleaseStatus; rollout_percent: number };
/** Newest serving release for this device: complete, or rolling and the device's bucket is inside the percent. */
export function pickRelease<T extends CandidateRelease>(releases: T[], device: string): T | null {
  const sorted = [...releases].sort((a, b) => compareVersions(b.version, a.version));
  return sorted.find((r) => r.status === "complete" || (r.status === "rolling" && inRollout(device, r.id, r.rollout_percent))) ?? null;
}

export type HealthCounts = { total: number; failures: number };
export function shouldRollback(c: HealthCounts, thresholdPercent: number, minReports: number): boolean {
  if (c.total < minReports || c.total === 0) return false;
  return (c.failures / c.total) * 100 >= thresholdPercent;
}

export function nextRolloutPercent(current: number, step: number): number {
  return Math.min(100, current + Math.max(0, step));
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
};
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** Derives a stable Ed25519 key pair from a random server secret (seed = SHA-256(secret)). */
export async function signingKeys(secret: string) {
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  const pkcs8 = new Uint8Array([...PKCS8_ED25519_PREFIX, ...seed]);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const raw = Uint8Array.from(atob(jwk.x!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (jwk.x!.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return { privateKey, publicKeyBase64: b64(raw) };
}

export async function signPayload(privateKey: CryptoKey, payload: unknown) {
  const body = canonicalJson(payload);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(body));
  return { body, signature: b64(sig) };
}

export async function verifyPayload(publicKeyBase64: string, payload: unknown, signature: string) {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)), new TextEncoder().encode(canonicalJson(payload)));
}

// Server-only GitHub App client: app JWT (RS256), installation lookup and short-lived installation tokens.
// Secrets: GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY. Tokens never leave the server.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { appRegistrationUrl, installUrl, missingPermissions, pemToPkcs8, signState } from "./github-app";

const API = "https://api.github.com";
const H = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy" };

/** App credentials: Project Secrets first; otherwise the encrypted record saved by the one-click manifest flow. */
export async function appConfig(): Promise<{ id: string; slug: string; key: string; webhookSecret: string | null; source: "secrets" | "manifest" } | null> {
  // Tolerated owner-saved secret names: GITHUB_APP_PIVATE_KEY (misspelling) and GITHUB_PRIVATE_KEY; whitespace-flattened PEMs are handled by pemToPkcs8.
  const id = process.env["GITHUB_APP_ID"], slug = process.env["GITHUB_APP_SLUG"], key = process.env["GITHUB_APP_PRIVATE_KEY"] ?? process.env["GITHUB_APP_PIVATE_KEY"] ?? process.env["GITHUB_PRIVATE_KEY"];
  if (id && slug && key) return { id, slug, key, webhookSecret: process.env["GITHUB_APP_WEBHOOK_SECRET"] ?? null, source: "secrets" };
  const enc = process.env["GITHUB_APP_ENCRYPTION_KEY"];
  if (!enc) return null;
  const { data } = await supabaseAdmin.from("github_app_credentials").select("app_id, slug, private_key_enc, webhook_secret_enc").eq("id", "jackboy").maybeSingle();
  if (!data) return null;
  const { decryptText } = await import("./github-app-manifest");
  return { id: data.app_id, slug: data.slug, key: await decryptText(data.private_key_enc, enc), webhookSecret: data.webhook_secret_enc ? await decryptText(data.webhook_secret_enc, enc) : null, source: "manifest" };
}

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function appJwt(): Promise<string> {
  const c = await appConfig(); if (!c) throw new Error("GitHub App is not set up yet.");
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(c.key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: c.id })}`;
  return `${body}.${b64u(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body))))}`;
}

async function call<T>(path: string, auth: string, method = "GET"): Promise<T> {
  const r = await fetch(`${API}${path}`, { method, headers: { ...H, Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

const cache = new Map<number, { token: string; exp: number }>();
async function installationToken(id: number): Promise<string> {
  const hit = cache.get(id); if (hit && hit.exp > Date.now() + 120_000) return hit.token;
  const r = await call<{ token: string; expires_at: string }>(`/app/installations/${id}/access_tokens`, await appJwt(), "POST");
  cache.set(id, { token: r.token, exp: Date.parse(r.expires_at) });
  return r.token;
}

/** Verifies an installation with GitHub itself, records repos/permissions, returns what is still missing. */
export async function recordInstallation(installationId: number, approvedBy: string | null) {
  const inst = await call<{ account: { login: string; type: string }; permissions: Record<string, string> }>(`/app/installations/${installationId}`, await appJwt());
  const tok = await installationToken(installationId);
  const repos = await call<{ repositories: { full_name: string }[] }>(`/installation/repositories?per_page=100`, tok);
  const missing = missingPermissions(inst.permissions);
  const row = { installation_id: installationId, account_login: inst.account.login, account_type: inst.account.type, repositories: repos.repositories.map((r) => r.full_name), permissions: inst.permissions, missing_permissions: missing, approved_by: approvedBy, verified_at: new Date().toISOString(), revoked: false, updated_at: new Date().toISOString() };
  const { error } = await supabaseAdmin.from("github_installations").upsert(row);
  if (error) throw new Error(`Could not store installation: ${error.message}`);
  return row;
}

/** Re-reads every installation of the app from GitHub and records it (used when no webhook/setup callback ran). */
export async function syncInstallations(approvedBy: string | null) {
  if (!(await appConfig())) return [];
  const list = await call<{ id: number }[]>(`/app/installations?per_page=100`, await appJwt());
  const out = [];
  for (const i of list) out.push(await recordInstallation(i.id, approvedBy));
  return out;
}

let lastSync = 0;
/** Personal GITHUB_TOKEN is used only for these repos; everything else must go through the GitHub App. */
export const PERSONAL_TOKEN_REPOS = ["street-tech666/jackboy-dev-control"];
export const tokenAllowedFor = (repoFull: string | null) => !repoFull || PERSONAL_TOKEN_REPOS.includes(repoFull.toLowerCase());

/** App installation token for repos it covers; personal GITHUB_TOKEN only for PERSONAL_TOKEN_REPOS. */
export async function githubTokenFor(repoFull: string | null): Promise<{ token: string; via: "app" | "token" } | null> {
  if (repoFull && (await appConfig())) {
    const find = async () => (await supabaseAdmin.from("github_installations").select("installation_id, repositories").eq("revoked", false).contains("repositories", [repoFull]).limit(1)).data?.[0]?.installation_id;
    let id = await find();
    if (!id && Date.now() - lastSync > 10 * 60_000) { lastSync = Date.now(); await syncInstallations(null).catch((e) => console.error("installation sync failed", (e as Error).message)); id = await find(); }
    if (id) { try { return { token: await installationToken(Number(id)), via: "app" }; } catch (e) { console.error("installation token failed", (e as Error).message); } }
  }
  const t = process.env["GITHUB_TOKEN"];
  return t && tokenAllowedFor(repoFull) ? { token: t, via: "token" } : null;
}

/** Access for app-covered repos comes from the recorded installation: GitHub reports the repo's user-style `permissions` field as all-false for app installation tokens. */
export async function appAccessFor(repoFull: string): Promise<{ canWrite: boolean; permissions: Record<string, string> } | null> {
  const { data } = await supabaseAdmin.from("github_installations").select("permissions").eq("revoked", false).contains("repositories", [repoFull]).limit(1);
  const p = data?.[0]?.permissions as Record<string, string> | undefined;
  if (!p) return null;
  return { canWrite: p["contents"] === "write", permissions: p };
}

export function repoFromPath(path: string): string | null {
  const m = path.match(/^\/repos\/([^/]+)\/([^/?]+)/);
  return m ? `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}` : null;
}

export function appOrigin() {
  return process.env["PUBLIC_APP_ORIGIN"] ?? "https://jackboy-dev-control.lovable.app";
}

/** Real, actionable GitHub authorization for a repo: install link with signed state, or the official app-registration page. */
export async function githubAuthorization(repoFull: string | null, userId: string, projectId: string | null, lastError: string | null) {
  const owner = repoFull?.split("/")[0] ?? null;
  const c = await appConfig();
  const { data: inst } = repoFull ? await supabaseAdmin.from("github_installations").select("account_login, repositories, missing_permissions, verified_at").eq("revoked", false).contains("repositories", [repoFull]).limit(1) : { data: [] };
  const have = inst?.[0];
  const automatic = ["Verify the grant with real GitHub calls (read, temporary branch create/delete, PR list)", "Retry the queued task that was waiting on this access", "Log the approval in the Site Log"];
  const ownerMust = ["Approve merges, deployments and any security or permission change (Guardian rule, owner only)"];
  const missing = have ? have.missing_permissions : ["Contents: Read & write", "Pull requests: Read & write", "Actions: Read-only (CI results only)"];
  if (have && missing.length === 0) return { provider: "GitHub", repo: repoFull, state: "authorized", missing: [], automatic, ownerMust, links: [], detail: `GitHub App installation on ${have.account_login} covers ${repoFull} (verified ${have.verified_at}).`, lastError };
  if (!c) {
    if (!owner) return { provider: "GitHub", repo: repoFull, state: "needs_repo", missing, automatic, ownerMust, links: [], detail: "Link a repository to this project first.", lastError };
    return {
      provider: "GitHub", repo: repoFull, state: "needs_app_registration", missing, automatic,
      ownerMust: [`Create the Jackboy GitHub App on ${owner} (GitHub pre-fills least-privilege permissions; you review and click Create)`, "Then add GITHUB_APP_ID, GITHUB_APP_SLUG and the generated private key as GITHUB_APP_PRIVATE_KEY in Project Settings → Secrets — never in chat", ...ownerMust],
      links: [{ label: `Create Jackboy GitHub App on ${owner}`, url: appRegistrationUrl(owner, appOrigin()), primary: true }, { label: `Or: approve existing key requests in ${owner}`, url: `https://github.com/organizations/${owner}/settings/personal-access-token-requests` }],
      detail: "No GitHub App is configured yet, so there is no installation link to open. This official page registers one; nothing is approved until you create and install it.", lastError,
    };
  }
  const secret = process.env["JACKBOY_SIGNING_SECRET"];
  if (!secret) return { provider: "GitHub", repo: repoFull, state: "server_setup_needed", missing, automatic, ownerMust, links: [], detail: "JACKBOY_SIGNING_SECRET is missing, so a safe install link cannot be signed.", lastError };
  const state = await signState({ u: userId, p: projectId, exp: Date.now() + 30 * 60_000 }, secret);
  return {
    provider: "GitHub", repo: repoFull, state: have ? "needs_more_permissions" : "needs_install", missing, automatic,
    ownerMust: [`On GitHub, install (or update) the ${c.slug} app on ${owner ?? "the organization"} and select only ${repoFull ?? "the needed repository"}`, ...ownerMust],
    links: [{ label: have ? `Update ${c.slug} permissions on GitHub` : `Install ${c.slug} on ${owner ?? "GitHub"}`, url: installUrl(c.slug, state), primary: true }],
    detail: "This link expires in 30 minutes and only works for your signed-in owner account.", lastError,
  };
}

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { explainFailure, LINKS, ORG, pickRepos, tokenKind, type Reason } from "./github-token";

type RepoResult = { repo: string; read: boolean; write: boolean | null; private: boolean | null; problem: Reason | null };

/** Owner-only: check what the GITHUB_TOKEN backend secret can actually do. Never returns the token. */
export const verifyGithubToken = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { data: r } = await context.supabase.rpc("my_role");
  if (r !== "owner") throw new Error("Owner only.");
  const token = process.env["GITHUB_TOKEN"];
  const checkedAt = new Date().toISOString();
  if (!token) return { configured: false as const, checkedAt, fixUrl: LINKS.fineGrained };
  const kind = tokenKind(token);
  const gh = (path: string, init: RequestInit = {}) => fetch(`https://api.github.com${path}`, {
    ...init, signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy", ...(init.headers ?? {}) },
  });
  const msgOf = async (res: Response) => { try { return String(((await res.json()) as { message?: string }).message ?? res.statusText); } catch { return res.statusText; } };

  const me = await gh("/user");
  if (!me.ok) return { configured: true as const, checkedAt, kind, valid: false, problem: explainFailure(me.status, await msgOf(me), "", kind, "read") };
  const user = (await me.json()) as { login: string };
  const scopes = me.headers.get("x-oauth-scopes");
  const expires = me.headers.get("github-authentication-token-expiration");

  // Org access: membership of the token owner and whether the org accepts this token.
  const orgRes = await gh(`/orgs/${ORG}`);
  const org = orgRes.ok ? { ok: true, problem: null } : { ok: false, problem: explainFailure(orgRes.status, await msgOf(orgRes), `${ORG}/`, kind, "read") };

  const { data: projects } = await context.supabase.from("owner_projects").select("github_repo").not("github_repo", "is", null);
  const known = [...new Set([...(projects ?? []).map((p: { github_repo: string }) => p.github_repo), `${ORG}/Omni`])];
  const listRes = await gh("/user/repos?per_page=100&sort=updated");
  const accessible = listRes.ok ? ((await listRes.json()) as { full_name: string }[]).map((x) => x.full_name) : [];
  const repos = pickRepos(known, accessible, ["jackboy", "terminal", "vault", "nano", "omni"]);

  const results: RepoResult[] = [];
  for (const repo of repos) {
    const res = await gh(`/repos/${repo}`);
    if (!res.ok) { results.push({ repo, read: false, write: null, private: null, problem: explainFailure(res.status, await msgOf(res), repo, kind, "read") }); continue; }
    const info = (await res.json()) as { private: boolean; default_branch: string };
    // Real write probe: create and immediately delete a throwaway branch (same check Connect uses).
    const ref = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(info.default_branch)}`);
    if (!ref.ok) { results.push({ repo, read: false, write: null, private: info.private, problem: explainFailure(ref.status, await msgOf(ref), repo, kind, "read") }); continue; }
    const sha = ((await ref.json()) as { object: { sha: string } }).object.sha;
    const name = `jackboy-token-check-${Date.now()}`;
    const mk = await gh(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${name}`, sha }) });
    if (mk.ok) {
      await gh(`/repos/${repo}/git/refs/heads/${name}`, { method: "DELETE" });
      results.push({ repo, read: true, write: true, private: info.private, problem: null });
    } else {
      results.push({ repo, read: true, write: false, private: info.private, problem: explainFailure(mk.status, await msgOf(mk), repo, kind, "write") });
    }
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("audit_logs").insert({ actor: context.userId, action: "github.token.verified", outcome: "ok",
    detail: { login: user.login, kind, org: org.ok, repos: results.map((x) => ({ repo: x.repo, read: x.read, write: x.write })) } as never });
  return { configured: true as const, checkedAt, kind, valid: true, login: user.login, scopes, expires, org, repos: results, fixUrl: kind === "classic" ? LINKS.classic : LINKS.fineGrained };
});

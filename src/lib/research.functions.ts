import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ALLOWED_DOMAINS, MAX_RESULTS, SEARCH_TIMEOUT_MS, hostAllowed, rateLimitStatus, validateQuery } from "./search-policy";

type Ctx = { supabase: any; userId: string };

async function requireMember(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (!data) throw new Error("Forbidden: Jackboy access requires an accepted invitation.");
  return data as string;
}

async function audit(ctx: Ctx, action: string, detail: Record<string, unknown>, outcome: string) {
  await ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });
}

export type SearchResult = { title: string; url: string; snippet: string; age: string | null; host: string };

export const runResearchSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { query: string }) => input)
  .handler(async ({ data, context }) => {
    await requireMember(context);
    const check = validateQuery(data.query);
    if (!check.ok) {
      await audit(context, "search", { reason: check.reason }, "rejected");
      return { status: "rejected" as const, message: check.reason, results: [] as SearchResult[] };
    }
    const key = process.env["BRAVE_SEARCH_API_KEY"];
    if (!key) {
      await audit(context, "search", { query: check.query }, "not_configured");
      return { status: "not_configured" as const, message: "Search API key is not configured. No results were fetched.", results: [] as SearchResult[] };
    }
    const now = Date.now();
    const since = (ms: number) => new Date(now - ms).toISOString();
    const count = async (ms: number) =>
      (await context.supabase.from("audit_logs").select("id", { count: "exact", head: true })
        .eq("actor", context.userId).eq("action", "search").eq("outcome", "ok").gte("at", since(ms))).count ?? 0;
    const limit = rateLimitStatus(await count(60_000), await count(86_400_000));
    if (!limit.allowed) {
      await audit(context, "search", { query: check.query }, "rate_limited");
      return { status: "rate_limited" as const, message: limit.reason!, results: [] as SearchResult[] };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(check.query)}&count=20&safesearch=strict`;
      const res = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: ctrl.signal });
      if (!res.ok) {
        console.error("Brave search failed", res.status);
        await audit(context, "search", { query: check.query, http: res.status }, "provider_error");
        return { status: "provider_error" as const, message: `Search provider returned an error (${res.status}).`, results: [] as SearchResult[] };
      }
      const json = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string; age?: string }> } };
      const raw = json.web?.results ?? [];
      const results: SearchResult[] = raw
        .filter((r) => hostAllowed(r.url))
        .slice(0, MAX_RESULTS)
        .map((r) => ({
          title: r.title.replace(/<[^>]+>/g, ""),
          url: r.url,
          snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
          age: r.age ?? null,
          host: new URL(r.url).hostname,
        }));
      await audit(context, "search", { query: check.query, returned: results.length, dropped: raw.length - results.length }, "ok");
      return { status: "ok" as const, message: `${results.length} results from allowed domains (${raw.length - results.length} outside the allowlist dropped).`, results, fetchedAt: new Date().toISOString() };
    } catch (e) {
      const timedOut = (e as Error).name === "AbortError";
      await audit(context, "search", { query: check.query }, timedOut ? "timeout" : "provider_error");
      return { status: timedOut ? ("timeout" as const) : ("provider_error" as const), message: timedOut ? `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s.` : "Search provider could not be reached.", results: [] as SearchResult[] };
    } finally {
      clearTimeout(timer);
    }
  });

/** Backend + external API checks. Browser reachability is measured client-side. */
export const checkConnectivity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const role = await requireMember(context);
    const t0 = Date.now();
    const db = await context.supabase.from("user_roles").select("id", { head: true, count: "exact" });
    const backend = { ok: !db.error, ms: Date.now() - t0 };
    const key = process.env["BRAVE_SEARCH_API_KEY"];
    let search: { state: "not_configured" | "ok" | "error"; detail: string; ms?: number } = { state: "not_configured", detail: "BRAVE_SEARCH_API_KEY secret missing." };
    if (key) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
      const t1 = Date.now();
      try {
        const res = await fetch("https://api.search.brave.com/res/v1/web/search?q=arxiv&count=1", { headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: ctrl.signal });
        search = res.ok ? { state: "ok", detail: "Search API responded.", ms: Date.now() - t1 } : { state: "error", detail: `Search API returned HTTP ${res.status}.`, ms: Date.now() - t1 };
      } catch (e) {
        search = { state: "error", detail: (e as Error).name === "AbortError" ? "Search API timed out." : "Search API unreachable." };
      } finally {
        clearTimeout(timer);
      }
    }
    await audit(context, "connectivity.test", { backend: backend.ok, search: search.state }, "ok");
    return { role, backend, search, allowedDomains: ALLOWED_DOMAINS.length, checkedAt: new Date().toISOString() };
  });

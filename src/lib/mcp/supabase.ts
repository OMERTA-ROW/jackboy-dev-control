import { createClient } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";
import type { Database } from "../../integrations/supabase/types";

// Env is read lazily inside handlers; module import must work without runtime env.
type RuntimeGlobals = typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};

function runtimeEnv(name: string): string | undefined {
  return (globalThis as RuntimeGlobals).process?.env?.[name];
}

function configuredEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = runtimeEnv(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function supabaseProjectUrl(): string {
  const url = configuredEnv(["SUPABASE_URL", "VITE_SUPABASE_URL"]) ?? (import.meta.env["VITE_SUPABASE_URL"] as string | undefined);
  if (!url) throw new Error("SUPABASE_URL is required");
  return url;
}

function supabasePublishableKey(): string {
  const key = configuredEnv(["SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"])
    ?? (import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined);
  if (!key) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
  return key;
}

// Caller-scoped client: every query runs as the verified OAuth user, so RLS decides access.
export function supabaseForUser(ctx: ToolContext) {
  const token = ctx.getToken();
  if (!token) throw new Error("supabaseForUser requires a verified OAuth token");
  return createClient<Database>(supabaseProjectUrl(), supabasePublishableKey(), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

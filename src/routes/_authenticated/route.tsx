import { createFileRoute, Outlet, redirect, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { decideRole, decideUser, gateCacheValid, GATE_CONNECTION_MESSAGE } from "@/lib/auth-gate";

type Role = "owner" | "admin" | "member";
let cache: { token: string; at: number; user: User; role: Role } | null = null;

class GateConnectionError extends Error {
  constructor(public reason: string) {
    super(GATE_CONNECTION_MESSAGE);
    this.name = "GateConnectionError";
  }
}

// Client-only gate: the session lives in browser storage. Server functions re-check auth + role independently.
// Rules in src/lib/auth-gate.ts: a dropped connection shows Try again; it never signs out or removes access.
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
    if (cache && gateCacheValid(cache, token, Date.now())) return { user: cache.user, role: cache.role };
    cache = null;
    const u = await supabase.auth.getUser();
    const userDecision = decideUser({ user: u.data.user, error: u.error });
    if (userDecision?.kind === "signin") throw redirect({ to: "/auth" });
    if (userDecision?.kind === "retry") throw new GateConnectionError(userDecision.reason);
    const r = await supabase.rpc("my_role");
    const d = decideRole({ role: r.data, error: r.error });
    if (d.kind === "onboarding") throw redirect({ to: "/onboarding" });
    if (d.kind !== "ok") throw new GateConnectionError(d.kind === "retry" ? d.reason : "unknown");
    if (token) cache = { token, at: Date.now(), user: u.data.user!, role: d.role };
    return { user: u.data.user!, role: d.role };
  },
  errorComponent: GateError,
  component: () => <Outlet />,
});

function GateError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const connection = error instanceof Error && error.name === "GateConnectionError";
  const retry = () => {
    void router.invalidate();
    reset();
  };
  useEffect(() => {
    if (!connection) return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  });
  return (
    <div className="mx-auto mt-16 max-w-md space-y-3 text-center" role="alert">
      <h1 className="text-lg font-semibold text-silver">{connection ? "Connection problem" : "This page didn't load"}</h1>
      <p className="text-sm text-muted-foreground">{connection ? error.message : "Something went wrong loading this page."}</p>
      <button onClick={retry} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Try again</button>
    </div>
  );
}

import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

// Client-only gate: the session lives in browser storage. Server functions re-check auth + role independently.
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: role } = await supabase.rpc("my_role");
    if (!role) throw redirect({ to: "/onboarding" });
    return { user: data.user, role: role as "owner" | "admin" | "member" };
  },
  component: () => <Outlet />,
});

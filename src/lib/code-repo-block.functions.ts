import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function owner(ctx: { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can manage the CODE block list.");
  return ctx.userId;
}
export const codeRepoBlockTarget = (repo: string, blocked: boolean) => `${blocked ? "block" : "unblock"}:${repo}`;

/** Owner read: repositories excluded from org-wide CODE. */
export const listCodeRepoBlocks = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    const { data, error } = await (context as { supabase: import("@supabase/supabase-js").SupabaseClient }).supabase
      .from("code_repo_blocklist").select("repo, reason, created_at").order("repo");
    if (error) throw new Error("The CODE block list couldn't be read.");
    return data ?? [];
  });

/** Fresh passkey: block or unblock one OMERTA-ROW repository. Logged by the database. */
export const setCodeRepoBlock = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ repo: z.string().regex(/^OMERTA-ROW\/[A-Za-z0-9._-]{1,100}$/), blocked: z.boolean(), reason: z.string().max(300).default(""), grantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const { consumeGrant } = await import("./passkey.server");
    await consumeGrant(data.grantId, actor, "code_repo_block", codeRepoBlockTarget(data.repo, data.blocked), { requireFresh: true });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc("set_code_repo_block", { p_actor: actor, p_repo: data.repo, p_blocked: data.blocked, p_reason: data.reason });
    if (error) throw new Error(`The block list wasn't changed (${error.code ?? "error"}).`);
    return { repo: data.repo, blocked: data.blocked };
  });

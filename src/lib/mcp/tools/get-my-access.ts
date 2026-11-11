import { defineTool } from "@lovable.dev/mcp-js";
import { supabaseForUser } from "../supabase";
import { failIfError } from "../util";

export default defineTool({
  name: "get_my_access",
  title: "Get my access",
  description: "Show which Jackboy account is connected and its role (owner, admin, member, or none).",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    const { data, error } = await supabaseForUser(ctx).rpc("my_role");
    failIfError(error, "your role");
    const role = typeof data === "string" ? data : null;
    const email = ctx.getUserEmail() ?? null;
    return {
      content: [{ type: "text", text: role ? `Signed in as ${email ?? "this account"} with role: ${role}.` : `Signed in as ${email ?? "this account"}, but it has no Jackboy access yet.` }],
      structuredContent: { email, role },
    };
  },
});

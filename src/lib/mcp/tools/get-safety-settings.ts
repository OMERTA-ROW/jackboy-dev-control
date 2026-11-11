import { defineTool } from "@lovable.dev/mcp-js";
import { supabaseForUser } from "../supabase";
import { failIfError } from "../util";

export default defineTool({
  name: "get_safety_settings",
  title: "Get safety settings",
  description: "Read the Kill Switch, Guardian verification, approval level and file/line limits. CODE and Emergency Stop state are not available here.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    const { data, error } = await supabaseForUser(ctx)
      .from("automation_policy")
      .select("paused, guardian_verified, tier, max_files, max_lines, updated_at")
      .limit(1)
      .maybeSingle();
    failIfError(error, "safety settings");
    if (!data) return { content: [{ type: "text", text: "No safety settings are visible to this account." }], structuredContent: { settings: null } };
    const settings = {
      killSwitchOn: data.paused,
      guardianVerified: data.guardian_verified,
      approvalLevel: data.tier,
      maxFiles: data.max_files,
      maxLines: data.max_lines,
      updatedAt: data.updated_at,
    };
    return {
      content: [{ type: "text", text: `Kill Switch ${data.paused ? "ON (all work paused)" : "off"}. Guardian verified: ${data.guardian_verified ? "yes" : "no"}. Approval level ${data.tier}; limit ${data.max_files} files / ${data.max_lines} lines. Updated ${data.updated_at}.` }],
      structuredContent: { settings },
    };
  },
});

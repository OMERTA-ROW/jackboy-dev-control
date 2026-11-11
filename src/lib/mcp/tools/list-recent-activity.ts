import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { clip, failIfError } from "../util";

export default defineTool({
  name: "list_recent_activity",
  title: "List recent activity",
  description: "Read the newest entries from Jackboy's activity log (owner only), optionally filtered by category.",
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("How many entries to return (default 20)."),
    category: z.string().trim().min(1).max(60).optional().describe("Only entries in this category."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit, category }, ctx) => {
    let q = supabaseForUser(ctx)
      .from("site_log")
      .select("id, at, actor, action, category, status, summary, repo, pr_url")
      .order("at", { ascending: false })
      .limit(limit ?? 20);
    if (category) q = q.eq("category", category);
    const { data, error } = await q;
    failIfError(error, "activity");
    const entries = (data ?? []).map((e) => ({
      id: e.id, at: e.at, actor: e.actor, action: e.action, category: e.category, status: e.status, summary: clip(e.summary), repo: e.repo, prUrl: e.pr_url,
    }));
    const text = entries.length === 0 ? "No activity visible to this account."
      : entries.map((e) => `${e.at} [${e.category}/${e.status}] ${e.action}: ${e.summary ?? ""}`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { entries } };
  },
});

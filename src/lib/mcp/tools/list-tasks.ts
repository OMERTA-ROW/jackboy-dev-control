import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { clip, failIfError } from "../util";

export default defineTool({
  name: "list_tasks",
  title: "List tasks",
  description: "List Task Mode runs (owner only) with status, failure count and stop reason.",
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("How many tasks to return (default 20)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    const { data, error } = await supabaseForUser(ctx)
      .from("tasks")
      .select("id, goal, status, failures, stop_reason, created_at, finished_at")
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);
    failIfError(error, "tasks");
    const tasks = (data ?? []).map((t) => ({
      id: t.id, goal: clip(t.goal, 200), status: t.status, failures: t.failures, stopReason: clip(t.stop_reason, 200), createdAt: t.created_at, finishedAt: t.finished_at,
    }));
    const text = tasks.length === 0 ? "No tasks visible to this account."
      : tasks.map((t) => `${t.id}: ${t.status} — ${t.goal ?? ""}${t.stopReason ? ` (stopped: ${t.stopReason})` : ""}`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { tasks } };
  },
});

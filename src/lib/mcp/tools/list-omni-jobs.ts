import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { clip, failIfError } from "../util";

export default defineTool({
  name: "list_omni_jobs",
  title: "List OMNI jobs",
  description: "List build and test jobs handed to OMNI with their recorded status. A job is only 'sent' if Jackboy recorded a send time.",
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("How many jobs to return (default 20)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    const { data, error } = await supabaseForUser(ctx)
      .from("omni_jobs")
      .select("id, kind, status, repo, created_at, sent_at, completed_at, last_error, pr_url")
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);
    failIfError(error, "OMNI jobs");
    const jobs = (data ?? []).map((j) => ({
      id: j.id, kind: j.kind, status: j.status, repo: j.repo, createdAt: j.created_at, sentAt: j.sent_at, completedAt: j.completed_at, lastError: clip(j.last_error, 200), prUrl: j.pr_url,
    }));
    const text = jobs.length === 0 ? "No OMNI jobs."
      : jobs.map((j) => `${j.id}: ${j.kind} — ${j.status}${j.sentAt ? `, sent ${j.sentAt}` : ", never sent"}${j.repo ? ` (${j.repo})` : ""}`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { jobs } };
  },
});

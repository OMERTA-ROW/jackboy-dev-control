import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { failIfError } from "../util";

export default defineTool({
  name: "list_projects",
  title: "List projects",
  description: "List the projects registered in Jackboy with enrollment, repository and health, optionally filtered by name.",
  inputSchema: {
    search: z.string().trim().min(1).max(100).optional().describe("Only projects whose name contains this text."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ search }, ctx) => {
    let q = supabaseForUser(ctx)
      .from("agent_projects")
      .select("id, name, enrolled, repo_url, health, last_report_at")
      .order("name")
      .limit(100);
    if (search) q = q.ilike("name", `%${search.replace(/[%_]/g, "\\$&")}%`);
    const { data, error } = await q;
    failIfError(error, "projects");
    const projects = (data ?? []).map((p) => ({
      id: p.id, name: p.name, enrolled: p.enrolled, repoUrl: p.repo_url, health: p.health, lastReportAt: p.last_report_at,
    }));
    const text = projects.length === 0 ? "No projects found."
      : projects.map((p) => `${p.name} — ${p.enrolled ? "enrolled" : "not enrolled"}${p.repoUrl ? `, ${p.repoUrl}` : ", no repo"}${p.health ? `, health ${p.health}` : ""} (${p.id})`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { projects } };
  },
});

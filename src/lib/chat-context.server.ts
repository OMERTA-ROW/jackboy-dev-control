// Loads a chat context's STORED notes with the caller's own (owner, RLS-scoped) client.
import type { SupabaseClient } from "@supabase/supabase-js";
import { JACKBOY_BRIEF, parseContextKey, storedNotes, type ContextBrief, type WorkNote } from "./chat-context";
import { untyped } from "./untyped-db";

type Project = { id: string; name: string; description: string | null; goals: string | null; notes: string | null; github_repo: string | null; updated_at: string | null };

async function projectParts(sb: SupabaseClient, projectId: string) {
  const db = untyped(sb);
  const [p, mem] = await Promise.all([
    db.from("owner_projects").select("id, name, description, goals, notes, github_repo, updated_at").eq("id", projectId).maybeSingle(),
    db.from("agent_memory").select("kind, summary, url, created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(6),
  ]);
  const project = (p.data ?? null) as Project | null;
  const work: WorkNote[] = ((mem.data ?? []) as { kind: string; summary: string; url: string | null; created_at: string }[])
    .map((m) => ({ kind: m.kind, summary: m.summary.slice(0, 400), at: m.created_at, url: m.url }));
  return { project, work };
}

/** Returns null for an unknown/forbidden key, so the chat refuses rather than guessing. */
export async function loadContextBrief(sb: SupabaseClient, key: unknown): Promise<ContextBrief | null> {
  const ref = parseContextKey(key);
  if (!ref) return null;
  if (ref.type === "jackboy") return JACKBOY_BRIEF;
  if (ref.type === "project") {
    const { project, work } = await projectParts(sb, ref.id);
    if (!project) return null;
    return {
      key: `project:${project.id}`, name: project.name, role: "Project", kind: "project",
      notes: storedNotes([
        { label: "Project description", text: project.description, updatedAt: project.updated_at },
        { label: "Project goals", text: project.goals, updatedAt: project.updated_at },
        { label: "Project notes", text: project.notes, updatedAt: project.updated_at },
      ]),
      work, projectId: project.id, projectName: project.name, hasRepo: Boolean(project.github_repo),
    };
  }
  const { data } = await untyped(sb).from("chat_contexts").select("id, name, role, kind, notes, notes_updated_at, project_id").eq("id", ref.id).maybeSingle();
  const c = data as { id: string; name: string; role: string; kind: "agent" | "visual_observer"; notes: string; notes_updated_at: string | null; project_id: string | null } | null;
  if (!c) return null;
  const linked = c.project_id ? await projectParts(sb, c.project_id) : { project: null, work: [] };
  return {
    key: `agent:${c.id}`, name: c.name, role: c.role, kind: c.kind,
    notes: storedNotes([
      { label: `Owner notes about ${c.name}`, text: c.notes, updatedAt: c.notes_updated_at },
      ...(linked.project ? [
        { label: `${linked.project.name} description`, text: linked.project.description, updatedAt: linked.project.updated_at },
        { label: `${linked.project.name} goals`, text: linked.project.goals, updatedAt: linked.project.updated_at },
        { label: `${linked.project.name} notes`, text: linked.project.notes, updatedAt: linked.project.updated_at },
      ] : []),
    ]),
    work: linked.work, projectId: linked.project?.id ?? null, projectName: linked.project?.name ?? null, hasRepo: Boolean(linked.project?.github_repo),
  };
}

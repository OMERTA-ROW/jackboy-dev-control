// Chat context switching (pure, tested). A context changes which STORED notes Jackboy reads; it
// never claims another agent is connected and never invents facts when notes are empty.

export type ContextRef = { type: "jackboy" } | { type: "agent" | "project"; id: string };
export type ContextKind = "jackboy" | "agent" | "visual_observer" | "project";
export type StoredNote = { label: string; text: string; updatedAt: string | null };
export type WorkNote = { kind: string; summary: string; at: string; url: string | null };
export type ContextBrief = {
  key: string;
  name: string;
  role: string;
  kind: ContextKind;
  notes: StoredNote[];
  work: WorkNote[];
  projectId: string | null;
  projectName: string | null;
  hasRepo: boolean;
};

export const JACKBOY_KEY = "jackboy";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseContextKey(key: unknown): ContextRef | null {
  if (key === JACKBOY_KEY || key === undefined || key === null || key === "") return { type: "jackboy" };
  if (typeof key !== "string") return null;
  const m = /^(agent|project):(.+)$/.exec(key);
  if (!m || !UUID.test(m[2]!)) return null;
  return { type: m[1] as "agent" | "project", id: m[2]!.toLowerCase() };
}
export const agentKey = (id: string) => `agent:${id}`;
export const projectKey = (id: string) => `project:${id}`;

export const JACKBOY_BRIEF: ContextBrief = {
  key: JACKBOY_KEY, name: "Jackboy", role: "Update and repair engineer", kind: "jackboy",
  notes: [], work: [], projectId: null, projectName: null, hasRepo: false,
};

/** Only non-empty stored text counts as a note; whitespace never becomes a "fact". */
export function storedNotes(entries: { label: string; text: string | null | undefined; updatedAt?: string | null }[]): StoredNote[] {
  return entries
    .map((e) => ({ label: e.label, text: (e.text ?? "").trim(), updatedAt: e.updatedAt ?? null }))
    .filter((e) => e.text.length > 0);
}
export const hasStoredNotes = (b: ContextBrief) => b.notes.length > 0 || b.work.length > 0;

/** Rules for every visual attachment. Observational only; ambiguous motion is labeled uncertain. */
export const VISUAL_POLICY = [
  "When the owner attaches images or video frames, describe only what is visible.",
  "Descriptions are observations, never medical, veterinary, psychological or health diagnoses: do not name or suggest conditions, causes or treatments.",
  "A video arrives as still frames taken at the listed timestamps; you did not see motion between frames.",
  "Any movement you infer between frames that is not clearly shown must be labeled 'Uncertain:'.",
  "Say how many images or frames you looked at. If something is too small, dark or blurry to tell, say so instead of guessing.",
].join(" ");

const OBSERVER_POLICY = (name: string) =>
  `${name} is a visual observer context. Every description of ${name} is an observational note only, not a diagnosis. ` +
  "Start each visual answer with 'Observation:' and list unclear movement under 'Uncertain:'. If the owner asks for a diagnosis, say you can only describe what is visible and suggest asking a qualified professional.";

const NOTE_BUDGET = 6000;

/** System text added for a context. Jackboy's own context adds nothing. */
export function contextInstructions(b: ContextBrief | null): string {
  if (!b || b.kind === "jackboy") return "";
  const head =
    `CONTEXT: The owner switched this conversation to ${b.name}${b.role ? ` (${b.role})` : ""}. ` +
    `You are still Jackboy, answering about ${b.name}; never speak as ${b.name}, and never claim ${b.name} is connected, running or did something unless a tool result shows it. ` +
    `Use ONLY the stored notes below as facts about ${b.name}; tools may add live facts. If the notes do not answer a question, say "No stored note covers that." Never invent facts.`;
  const lines: string[] = [];
  let used = 0;
  for (const n of b.notes) {
    const line = `- ${n.label}${n.updatedAt ? ` (updated ${n.updatedAt.slice(0, 10)})` : ""}: ${n.text}`;
    if (used + line.length > NOTE_BUDGET) { lines.push("- (more notes stored; not all included)"); break; }
    lines.push(line); used += line.length;
  }
  for (const w of b.work) {
    const line = `- Work note ${w.at.slice(0, 10)} [${w.kind}]: ${w.summary}${w.url ? ` (${w.url})` : ""}`;
    if (used + line.length > NOTE_BUDGET) break;
    lines.push(line); used += line.length;
  }
  const notes = lines.length
    ? `STORED NOTES for ${b.name} (verbatim from Jackboy's records):\n${lines.join("\n")}`
    : `STORED NOTES for ${b.name}: none stored yet. Say plainly that no notes are stored for ${b.name} and that the owner can add them; do not fill the gap with guesses.`;
  return [head, notes, b.kind === "visual_observer" ? OBSERVER_POLICY(b.name) : ""].filter(Boolean).join("\n");
}

/** Fixed label under visual answers in an observer context, independent of what the model wrote. */
export function observerLabel(kind: ContextKind | undefined, visual: boolean): string | null {
  if (!visual) return null;
  return kind === "visual_observer"
    ? "Observation only, not a medical diagnosis. Movement between frames is uncertain."
    : "Description of what is visible only. Movement between frames is uncertain.";
}

/** Who said it, for the label above each message. */
export function authorLabel(role: string, meta: { author?: unknown; contextName?: unknown; voice?: unknown } | undefined, viewerRole: string | null): string {
  const voice = meta?.voice ? " · voice" : "";
  if (role === "user") return `You${viewerRole ? ` · ${viewerRole[0]!.toUpperCase()}${viewerRole.slice(1)}` : ""}${voice}`;
  const ctx = typeof meta?.contextName === "string" && meta.contextName && meta.contextName !== "Jackboy" ? ` · ${meta.contextName} notes` : "";
  return `Jackboy${ctx}${voice}`;
}

export function slugFor(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s.length >= 2 ? s : `agent-${s || "x"}`;
}

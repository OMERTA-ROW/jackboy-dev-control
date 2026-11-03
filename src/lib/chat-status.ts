// Honest activity indicator: derived only from real events (voice engine, chat stream, CODE job state).
export type ActivityState = "error" | "awaiting_approval" | "listening" | "speaking" | "testing" | "coding" | "working" | "thinking" | null;
export type ActivityInput = {
  error?: boolean;
  listening?: boolean;              // browser STT or live call mic actively capturing
  speaking?: boolean;               // TTS audio actually playing / live model audio delta
  chatStatus?: "submitted" | "streaming" | "ready" | "error";
  liveThinking?: boolean;           // live call connecting/processing event
  codeBusy?: boolean;
  toolRunning?: boolean;            // a backend tool call is in progress (text tool part or live delegation)               // /api/code request in flight
  cards?: { status: string; expiresAt: string; run?: { status: string; jobs: { name: string; status: string }[] } | null }[];
  now?: number;
};
export const ACTIVITY_LABEL: Record<Exclude<ActivityState, null>, string> = {
  error: "Error", awaiting_approval: "Awaiting approval", listening: "Listening", speaking: "Speaking",
  testing: "Testing", coding: "Coding", working: "Working", thinking: "Thinking",
};
export function deriveActivity(i: ActivityInput): ActivityState {
  const now = i.now ?? Date.now();
  if (i.error || i.chatStatus === "error") return "error";
  if (i.listening) return "listening";
  if (i.speaking) return "speaking";
  const cards = i.cards ?? [];
  if (cards.some((c) => c.status === "pending" && Date.parse(c.expiresAt) > now)) return "awaiting_approval";
  const running = cards.filter((c) => c.status === "allowed" && c.run && c.run.status !== "completed");
  if (running.some((c) => c.run!.jobs.some((j) => j.status === "in_progress" && /test|check|lint|verify/i.test(j.name)))) return "testing";
  if (running.length) return "coding";
  if (i.toolRunning) return "working";
  if (i.chatStatus === "submitted" || i.chatStatus === "streaming" || i.liveThinking || i.codeBusy) return "thinking";
  return null;
}

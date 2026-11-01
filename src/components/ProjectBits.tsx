import type { ProjectStatus } from "@/lib/project-hub";

const TONE: Record<ProjectStatus["tone"], string> = {
  ok: "border-success/40 text-success",
  warn: "border-warning/40 text-warning",
  error: "border-destructive/40 text-destructive",
  muted: "border-border text-muted-foreground",
};

export function StatusPill({ status }: { status: ProjectStatus }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs ${TONE[status.tone]}`}>{status.label}</span>;
}

export const btn = "inline-flex min-h-9 items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:border-electric focus-visible:outline-2 focus-visible:outline-electric disabled:opacity-40";
export const primaryBtn = "inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-electric disabled:opacity-40";
export const field = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

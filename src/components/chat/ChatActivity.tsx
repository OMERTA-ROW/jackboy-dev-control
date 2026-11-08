import { isToolUIPart, type UIMessage } from "ai";
import {
  BookOpen,
  CheckCircle2,
  Code2,
  FlaskConical,
  Link2,
  Loader2,
  Search,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { redact } from "@/lib/chat-history";
import { safeEvidenceUrl } from "@/lib/chat-action";

const ACTIVITIES: Record<string, { label: string; icon: typeof BookOpen }> = {
  readFile: { label: "Reading repository files", icon: BookOpen },
  read_file: { label: "Reading repository files", icon: BookOpen },
  repoTree: { label: "Reading repository files", icon: BookOpen },
  repoSearch: { label: "Researching repository", icon: Search },
  research: { label: "Researching", icon: Search },
  searchWeb: { label: "Researching", icon: Search },
  writeFile: { label: "Writing and editing code", icon: Code2 },
  write_file: { label: "Writing and editing code", icon: Code2 },
  showDiff: { label: "Reviewing code changes", icon: Code2 },
  fixIssue: { label: "Repairing problems", icon: Wrench },
  foundryInspect: { label: "Inspecting repository", icon: Search },
  checkStatus: { label: "Checking test and build results", icon: FlaskConical },
  verifyPermissions: { label: "Checking GitHub permissions", icon: Link2 },
  connectionStatus: { label: "Checking connection", icon: Link2 },
  openDraftPR: { label: "Opening a draft pull request", icon: Link2 },
  capabilities: { label: "Checking available capabilities", icon: ShieldAlert },
  draftTask: { label: "Drafting a task for approval", icon: BookOpen },
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const clean = (value: string) =>
  redact(value)
    .replace(
      /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,
      "[hidden]",
    )
    .replace(/\b(Bearer|(?:api[_-]?key|token|secret|password)\s*[=:])\s*\S+/gi, "$1 [hidden]")
    .slice(0, 500);

/** Only named result fields are displayed; never source contents, prompts, credentials or reasoning. */
export function activityDetails(input: unknown, output: unknown): string[] {
  const args = record(input);
  const out = record(output);
  const result = record(out?.["result"]) ?? out;
  const lines: string[] = [];
  if (typeof args?.["path"] === "string") lines.push(`File: ${clean(args["path"])}`);
  for (const key of ["path", "commit", "status", "conclusion", "action"]) {
    if (typeof result?.[key] === "string") lines.push(`${key}: ${clean(result[key])}`);
  }
  if (typeof result?.["error"] === "string") lines.push(`Error: ${clean(result["error"])}`);
  if (out?.["blocked"] === true)
    lines.push(
      `Blocked: ${typeof out["reason"] === "string" ? clean(out["reason"]) : "Owner action required."}`,
    );
  for (const key of ["files", "runs"]) {
    if (!Array.isArray(result?.[key])) continue;
    for (const item of result[key].slice(0, 20)) {
      const row = record(item);
      if (!row) continue;
      const words = [
        row["filename"] ?? row["path"] ?? row["name"],
        row["status"],
        row["conclusion"],
      ].filter((s): s is string => typeof s === "string");
      if (words.length) lines.push(clean(words.join(" · ")));
    }
  }
  return [...new Set(lines)];
}

export function VerifiedActivity({
  label,
  running,
  failed,
  waiting,
  details,
  children,
  icon: Icon,
}: {
  label: string;
  running: boolean;
  failed: boolean;
  waiting?: boolean;
  details: string[];
  children?: React.ReactNode;
  icon?: typeof BookOpen;
}) {
  return (
    <details className="my-2 min-w-0 rounded-xl border border-border bg-card/50 px-3 py-2 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 break-words">
        {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
        {running ? (
          <Loader2 aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
        ) : failed ? (
          <ShieldAlert aria-hidden className="size-4 shrink-0 text-destructive" />
        ) : waiting ? (
          <BookOpen aria-hidden className="size-4 shrink-0 text-warning" />
        ) : (
          <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />
        )}
        <span>
          {label} ·{" "}
          {running
            ? "In progress"
            : failed
              ? "Blocked or failed"
              : waiting
                ? "Awaiting approval"
                : "Result received"}
        </span>
      </summary>
      <div className="mt-2 space-y-1 break-words text-xs text-muted-foreground">
        {details.length ? (
          details.map((line, i) => <p key={i}>{line}</p>)
        ) : (
          <p>No file or test details reported by this tool.</p>
        )}
        {children}
      </div>
    </details>
  );
}

export function ChatActivity({ parts }: { parts: UIMessage["parts"] }) {
  const tools = parts.filter(isToolUIPart);
  if (!tools.length) return null;
  return (
    <div aria-label="Verified tool activity" className="mb-3 min-w-0" aria-live="polite">
      {tools.map((part) => {
        const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
        const activity = ACTIVITIES[name] ?? { label: `Tool: ${name}`, icon: BookOpen };
        const running = part.state === "input-streaming" || part.state === "input-available";
        const output = record("output" in part ? part.output : null);
        const failed =
          part.state === "output-error" ||
          part.state === "output-denied" ||
          output?.["blocked"] === true ||
          typeof output?.["error"] === "string" ||
          typeof record(output?.["result"])?.["error"] === "string";
        const details = activityDetails("input" in part ? part.input : null, output);
        if ("errorText" in part && typeof part.errorText === "string")
          details.push(`Error: ${clean(part.errorText)}`);
        const evidence = Array.isArray(output?.["evidence"]) ? output["evidence"] : [];
        return (
          <VerifiedActivity
            key={part.toolCallId}
            label={activity.label}
            icon={activity.icon}
            running={running}
            failed={failed}
            waiting={part.state === "approval-requested" || part.state === "approval-responded"}
            details={details}
          >
            {evidence.map((item, i) => {
              const link = record(item);
              return typeof link?.["url"] === "string" &&
                typeof link["label"] === "string" &&
                safeEvidenceUrl(link["url"]) ? (
                <a key={i} className="mr-3 inline-block text-primary underline" href={link["url"]}>
                  {clean(link["label"])}
                </a>
              ) : null;
            })}
          </VerifiedActivity>
        );
      })}
    </div>
  );
}

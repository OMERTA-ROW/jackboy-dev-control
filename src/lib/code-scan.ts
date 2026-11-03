// Pure rules for Jackboy's source-code defect scan, AI-fix validation and update packages. Tested in code-scan.test.ts.
export type Defect = { rule: string; path: string; line: number; excerpt: string; title: string; why: string; risk: "low" | "sensitive" };

type Rule = { id: string; title: string; why: string; risk: "low" | "sensitive"; test: (line: string) => boolean };
export const RULES: Rule[] = [
  { id: "debugger-statement", title: "Remove leftover debugger statement", why: "A `debugger;` statement pauses execution in any open devtools and should never ship.", risk: "low",
    test: (l) => /^\s*debugger\s*;?\s*$/.test(l) },
  { id: "blank-target-no-rel", title: "Add rel=\"noopener noreferrer\" to target=\"_blank\" link", why: "Links opening a new tab without rel=noopener let the new page control the opener (reverse tabnabbing).", risk: "low",
    test: (l) => /target=["']_blank["']/.test(l) && !/\brel=/.test(l) },
  { id: "eval-call", title: "Replace eval() call", why: "eval executes arbitrary strings as code and is a code-injection risk.", risk: "sensitive",
    test: (l) => /(^|[^.\w])eval\s*\(/.test(code(l)) && !/^\s*(\/\/|\*)/.test(l) },
  { id: "hardcoded-secret", title: "Remove hard-coded secret", why: "A credential-looking literal is committed to source.", risk: "sensitive",
    test: (l) => /(sk_live_[0-9a-z]{10,}|ghp_[0-9A-Za-z]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(l) },
];

/** Line with string, template and regex literals blanked, so code-like text inside them is not reported. */
export function code(l: string): string {
  return l.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/(?:\\.|[^/\\\n])+\/[gimsuy]*/g, "/r/");
}

export const SCANNABLE = /\.(tsx?|jsx?|mjs|cjs|html)$/i;
const SKIP = /(^|\/)(node_modules|dist|build|\.output|coverage|vendor)\/|\.min\.js$|(^|\/)routeTree\.gen\.ts$|\.test\.|\.spec\.|code-scan\.ts$/;
export const scannable = (p: string) => SCANNABLE.test(p) && !SKIP.test(p);

/** Line-level scan of one file. Never reports secret values (excerpt is masked for secret rules). */
export function scanFile(path: string, content: string): Defect[] {
  const out: Defect[] = [];
  content.split("\n").forEach((l, i) => {
    for (const r of RULES) if (r.test(l)) out.push({ rule: r.id, path, line: i + 1, title: r.title, why: r.why, risk: r.risk, excerpt: r.id === "hardcoded-secret" ? "[secret masked]" : l.trim().slice(0, 200) });
  });
  return out;
}

/** Prioritize: low-risk auto-fixable first (smaller blast radius), then by path for stable order. */
export function prioritize(d: Defect[]): Defect[] {
  return [...d].sort((a, b) => (a.risk === b.risk ? a.path.localeCompare(b.path) || a.line - b.line : a.risk === "low" ? -1 : 1));
}

export const dedupeKey = (d: Pick<Defect, "rule" | "path" | "line">) => `scan:${d.rule}:${d.path}:${d.line}`;

/** Line diff stats (LCS-free approximation good enough for bounding a minimal patch). */
export function lineChanges(before: string, after: string) {
  const a = before.split("\n"), b = after.split("\n");
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { removed: a.length - s - e, added: b.length - s - e, firstChanged: s + 1 };
}

export type Validation = { ok: boolean; checks: { name: string; passed: boolean; detail: string }[] };
/** Deterministic gates for an AI-generated fix. All must pass before anything is committed. */
export function validateFix(d: Defect, before: string, after: string, maxChangedLines = 6): Validation {
  const checks: Validation["checks"] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  add("changed", after !== before && after.trim().length > 0, after === before ? "No change produced." : "File changed.");
  const still = scanFile(d.path, after).filter((x) => x.rule === d.rule).length;
  const was = scanFile(d.path, before).filter((x) => x.rule === d.rule).length;
  add("defect_removed", still < was, `${d.rule}: ${was} before, ${still} after.`);
  const newOnes = scanFile(d.path, after).filter((x) => x.rule !== d.rule).length - scanFile(d.path, before).filter((x) => x.rule !== d.rule).length;
  add("no_new_defects", newOnes <= 0, newOnes > 0 ? `${newOnes} new finding(s) introduced.` : "No new findings.");
  const c = lineChanges(before, after);
  add("minimal", c.added <= maxChangedLines / 2 && c.removed <= maxChangedLines / 2, `${c.removed} line(s) removed, ${c.added} added (limit ${maxChangedLines / 2} each).`);
  add("brackets_balanced", balance(before) === balance(after) || d.rule === "debugger-statement" && balance(after) === balance(before), `Bracket balance ${balance(before)} → ${balance(after)}.`);
  return { ok: checks.every((x) => x.passed), checks };
}
function balance(s: string) { let n = 0; for (const ch of s) { if ("({[".includes(ch)) n++; else if (")}]".includes(ch)) n--; } return n; }

/** Strip a model reply down to file content (handles ``` fences). */
export function extractCode(reply: string): string {
  const m = reply.match(/```[\w-]*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : reply).replace(/\s+$/, "") + "\n";
}

export type UpdatePackage = {
  schema: "jackboy.update-package/v1"; version: string; repo: string; branch: string; base: string; base_commit: string | null; commit: string;
  finding: Omit<Defect, "excerpt">; files: { path: string; before_sha256: string; after_sha256: string; added: number; removed: number }[];
  tests: Validation & { ci: { status: string; reason?: string } }; rollback: { strategy: "restore_previous_content"; files: { path: string; restore_sha256: string }[]; note: string };
  diff: string; package_sha256?: string;
};

/** Stable JSON (sorted keys) so the package checksum is reproducible. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function packageVersion(now: Date, seq: number) {
  return `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}-${seq}`;
}

/** Routine = low risk, validation passed, single file. Only routine work may open a draft PR without a card. Never merge/deploy. */
export function autoRunnable(d: Pick<Defect, "risk">, v: Validation, files: number) {
  return d.risk === "low" && v.ok && files === 1;
}

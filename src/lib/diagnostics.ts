export type Finding = { line: number; severity: "error" | "warning" | "info"; rule: string; message: string };

const RULES: { rule: string; severity: Finding["severity"]; re: RegExp; message: string }[] = [
  { rule: "possible-secret", severity: "error", re: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/i, message: "Possible hardcoded credential. Move it to a secret store." },
  { rule: "no-eval", severity: "error", re: /\beval\s*\(/, message: "eval() executes arbitrary code." },
  { rule: "inner-html", severity: "warning", re: /dangerouslySetInnerHTML|\.innerHTML\s*=/, message: "Raw HTML injection — sanitise input." },
  { rule: "explicit-any", severity: "warning", re: /:\s*any\b/, message: "Explicit `any` weakens type safety." },
  { rule: "console", severity: "info", re: /console\.(log|debug)\(/, message: "Leftover console output." },
  { rule: "todo", severity: "info", re: /\b(TODO|FIXME|HACK)\b/, message: "Unresolved marker." },
  { rule: "loose-equality", severity: "warning", re: /[^=!]==[^=]/, message: "Use === instead of ==." },
];

/** Static, local pattern checks. Not a compiler — results are heuristics. */
export function inspect(source: string): Finding[] {
  const out: Finding[] = [];
  source.split("\n").forEach((text, i) => {
    for (const r of RULES) if (r.re.test(text)) out.push({ line: i + 1, severity: r.severity, rule: r.rule, message: r.message });
    if (text.length > 120) out.push({ line: i + 1, severity: "info", rule: "line-length", message: `Line is ${text.length} chars (>120).` });
  });
  return out;
}

// Trusted runner gate. Run from the pristine publishing checkout BEFORE applying the model patch.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);

export function safeCodePath(path) {
  if (
    !path ||
    path.length > 300 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes('"') ||
    /[\x00-\x20\x7f]/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    return false;
  return !/(^|\/)\.github\/workflows(?:\/|$)|(^|\/)(\.git[^/]*|\.env[^/]*|\.npmrc|\.bunfig[^/]*|AGENTS\.md|node_modules|secrets?)(\/|$)|(^|\/)(auth[^/]*|passkey[^/]*|step-up[^/]*|.*credential.*|.*permission.*)(\/|\.|$)|\.(pem|key)$|^((drizzle|supabase)\/|src\/integrations\/|(scripts|tests)\/code-|src\/components\/CodeTasks\.tsx$|src\/lib\/(code|voice-guard|github)[^/]*|package(-lock)?\.json$|bun\.lock$|bunfig\.toml$)/i.test(
    path,
  );
}
function assertNoSymlinkPath(path, cwd) {
  const root = resolve(cwd);
  const rel = relative(root, resolve(root, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("CODE patch path escapes the repository.");
  }
  let current = root;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("CODE patch cannot traverse a symbolic link.");
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
function assertSafePatchPaths(text, cwd) {
  if (!text.startsWith("diff --git "))
    throw new Error("CODE patch contains an invalid or unsupported file header.");
  const sections = text.split(/^diff --git /m).slice(1);
  if (!sections.length) throw new Error("CODE patch contains no file changes.");
  for (const section of sections) {
    const [header, ...lines] = section.split("\n");
    const match = /^a\/([^\s]+) b\/([^\s]+)$/.exec(header ?? "");
    if (!match) throw new Error("CODE patch contains an invalid or ambiguous file path.");
    const paths = [match[1], match[2]];
    for (const line of lines) {
      const rename = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
      if (rename) paths.push(rename[1]);
      const oldPath = /^--- (.+)$/.exec(line)?.[1];
      if (oldPath && oldPath !== "/dev/null") {
        if (!oldPath.startsWith("a/"))
          throw new Error("CODE patch contains an invalid source path.");
        paths.push(oldPath.slice(2));
      }
      const newPath = /^\+\+\+ (.+)$/.exec(line)?.[1];
      if (newPath && newPath !== "/dev/null") {
        if (!newPath.startsWith("b/"))
          throw new Error("CODE patch contains an invalid destination path.");
        paths.push(newPath.slice(2));
      }
    }
    if (paths.some((path) => !safeCodePath(path))) {
      throw new Error(
        `CODE protected or invalid patch path: ${paths.find((path) => !safeCodePath(path))}`,
      );
    }
    for (const path of paths) assertNoSymlinkPath(path, cwd);
  }
}
export async function validateCodePatch(file, cwd = process.cwd()) {
  if (statSync(file).size > 500_000) throw new Error("CODE patch exceeds 500 KB.");
  const text = readFileSync(file, "utf8");
  if (!text.trim()) throw new Error("CODE produced no diff; there is no change to publish.");
  if (
    /^(new file mode|old mode|new mode) 1[26]0000$/m.test(text) ||
    /^GIT binary patch$/m.test(text)
  )
    throw new Error("CODE cannot publish symlinks, submodules or binary patches.");
  assertSafePatchPaths(text, cwd);
  const { stdout } = await exec(
    "git",
    ["-c", "core.quotePath=false", "apply", "--numstat", "-z", file],
    { cwd, encoding: "utf8", maxBuffer: 1_000_000 },
  );
  const names = stdout.split("\0");
  if (names.at(-1) === "") names.pop();
  if (!names.length || names.length > 20)
    throw new Error("CODE permits 1–20 changed files per job.");
  for (const line of names) {
    const parts = line.split("\t");
    if (parts.length !== 3 || parts[0] === "-" || parts[1] === "-" || !safeCodePath(parts[2]))
      throw new Error(`CODE protected or invalid patch path: ${parts.at(-1)}`);
  }
  await exec("git", ["apply", "--check", "--index", file], { cwd });
  return names.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await validateCodePatch(process.argv[2]);

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Static guard for requirement 7: the CODE-only provider credential is read by exactly one server file.
const KEY = "CODE_PROVIDER_API_KEY";
const GATEWAY = join("src", "lib", "code-gateway.server.ts");

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".output"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

test("the CODE provider key is referenced only by the gateway server module", async () => {
  const hits = [];
  for (const root of ["src", ".github", "drizzle", "docs"]) {
    for await (const file of walk(root)) {
      if (/\.(test\.[tm]?[jt]sx?|md)$/.test(file)) continue;
      if ((await readFile(file, "utf8")).includes(KEY)) hits.push(file);
    }
  }
  assert.deepEqual(hits, [GATEWAY]);
});

test("the gateway module is dynamically imported only for server-side readiness and the route", async () => {
  const importers = [];
  for await (const file of walk("src")) {
    if (!/\.[tj]sx?$/.test(file) || /\.test\./.test(file)) continue;
    if ((await readFile(file, "utf8")).includes("code-gateway.server")) importers.push(file);
  }
  assert.deepEqual(importers.sort(), [
    join("src", "lib", "code-safety.functions.ts"),
    join("src", "routes", "api", "public", "code", "provider.$.ts"),
  ]);
  const readiness = await readFile(join("src", "lib", "code-safety.functions.ts"), "utf8");
  assert.match(readiness, /await import\(["']\.\/code-gateway\.server["']\)/);
  assert.doesNotMatch(readiness, /import\s+.*from\s+["']\.\/code-gateway\.server["']/);
});

test("the gateway uses only function-bound server env and never logs the key", async () => {
  const source = await readFile(GATEWAY, "utf8");
  assert.doesNotMatch(source, /console\./);
  assert.match(source, /process\.env\[PROVIDER_KEY_ENV\]/);
});

test("no workflow receives a paid-provider secret", async () => {
  const offenders = [];
  for await (const file of walk(".github")) {
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(
      /secrets\.([A-Z0-9_]*(?:OPENAI|PROVIDER|ANTHROPIC|GEMINI|LOVABLE|AZURE)[A-Z0-9_]*)/g,
    )) {
      offenders.push(`${file}:${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

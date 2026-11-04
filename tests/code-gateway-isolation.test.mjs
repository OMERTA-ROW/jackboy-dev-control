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

test("the gateway module is never imported by client code and only the route reaches it", async () => {
  const importers = [];
  for await (const file of walk("src")) {
    if (!/\.[tj]sx?$/.test(file) || /\.test\./.test(file)) continue;
    if ((await readFile(file, "utf8")).includes("code-gateway.server")) importers.push(file);
  }
  assert.deepEqual(importers.sort(), [
    join("src", "routes", "api", "public", "code", "provider.$.ts"),
  ]);
});

test("the gateway uses only function-bound server env and never logs the key", async () => {
  const source = await readFile(GATEWAY, "utf8");
  assert.doesNotMatch(source, /console\./);
  assert.match(source, /process\.env\[PROVIDER_KEY_ENV\]/);
});

// Requirement 7 is only complete once the runner stops holding a provider key. This is the one known
// direct path; the test pins it so any additional bypass fails CI, and it must be removed at cutover.
test("known pending cutover: the only workflow-held provider key is the legacy runner secret", async () => {
  const offenders = [];
  for await (const file of walk(".github")) {
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(/secrets\.([A-Z0-9_]*(?:OPENAI|PROVIDER)[A-Z0-9_]*)/g)) {
      offenders.push(`${file}:${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [join(".github", "workflows", "code.yml") + ":OPENAI_API_KEY"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Later-numbered duplicates must stay SQL-equivalent to the reviewed originals the tests replay.
const norm = (f) =>
  readFileSync(`drizzle/migrations/${f}`, "utf8")
    .replace(/--> statement-breakpoint/g, "")
    .split("\n").filter((l) => !/^\s*--/.test(l)).join("").replace(/\s+/g, "");
test("journaled CODE migration copies are equivalent to their reviewed originals", () => {
  const files = readdirSync("drizzle/migrations").filter((f) => f.endsWith(".sql")).sort();
  const first = new Map();
  let copies = 0;
  for (const f of files) {
    const name = f.slice(5);
    if (name === "migration.sql") continue;
    if (!first.has(name)) { first.set(name, f); continue; }
    copies++;
    assert.equal(norm(f), norm(first.get(name)), `${f} differs from ${first.get(name)}`);
  }
  assert.ok(copies >= 5);
});

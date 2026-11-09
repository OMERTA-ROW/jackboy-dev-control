import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sql = readFileSync("scripts/code-production-evidence.sql", "utf8");

test("production evidence pack has bounded read-only transaction and fails on errors", () => {
  assert.match(sql, /\\set ON_ERROR_STOP on/);
  assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /SET LOCAL statement_timeout = '15s';/);
  assert.match(sql, /SET LOCAL lock_timeout = '2s';/);
  assert.match(sql, /ROLLBACK;\s*$/);
  const statements = sql
    .replace(/^--.*$/gm, "")
    .replace(/^\\.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    assert.match(statement, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/);
  }
});

test("production evidence pack catalogs entrypoints without invoking application functions", () => {
  assert.doesNotMatch(sql.replace(/'(?:''|[^'])*'/g, "''"), /public\.\w+\s*\(/);
  assert.doesNotMatch(sql, /\b(?:FROM|JOIN)\s+(?:vault|cron|auth)\./i);
  assert.doesNotMatch(sql, /\bpg_authid\b|\bSELECT\s+\*/i);
  assert.match(sql, /p\.oid IS NOT NULL AS present/);
  assert.match(sql, /t\.tgtype=7 AND t\.tgenabled='O'/);
  assert.match(sql, /has_function_privilege\('authenticated',p\.oid,'EXECUTE'\)/);
});

test("production evidence pack pins journal hashes to unmodified migration files", () => {
  for (const tag of [
    "0058_omni_link_approval_save",
    "0059_sync_safety_guards",
    "0060_code_acceptance_guard_verification",
  ]) {
    const bytes = readFileSync(`drizzle/migrations/${tag}.sql`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const journal = JSON.parse(readFileSync("drizzle/migrations/meta/_journal.json", "utf8"));
    const entry = journal.entries.find((item) => item.tag === tag);
    assert.ok(entry, `Missing journal entry for ${tag}`);
    assert.ok(sql.includes(`('${tag}', '${hash}', ${entry.when}::bigint)`));
  }
});

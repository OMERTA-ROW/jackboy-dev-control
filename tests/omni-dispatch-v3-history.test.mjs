// Guards the Lovable SQL-runner file that records the already-applied 0062 in Drizzle history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const sql = await read("scripts/record-omni-dispatch-v3-0062-history.sql");
const migration = await read("drizzle/migrations/0062_omni_dispatch_v3.sql");
const journal = JSON.parse(await read("drizzle/migrations/meta/_journal.json"));
const entry = journal.entries.find((e) => e.tag === "0062_omni_dispatch_v3");

test("embedded hash and created_at match the checked-in 0062 file and journal", () => {
  const hash = createHash("sha256").update(migration).digest("hex");
  assert.ok(entry);
  assert.match(sql, new RegExp(`expected_hash constant text := '${hash}'`));
  assert.match(sql, new RegExp(`expected_when constant bigint := ${entry.when};`));
  assert.equal(sql.match(/INSERT INTO/g)?.length, 1);
});

test("single transaction, no psql meta-commands, no other writes", () => {
  assert.equal(sql.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(sql.match(/^COMMIT;$/gm)?.length, 1);
  assert.ok(sql.indexOf("BEGIN;") < sql.indexOf("COMMIT;"));
  assert.doesNotMatch(sql, /^\s*\\/m);
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\s/im);
  assert.doesNotMatch(sql, /ON CONFLICT/i);
});

test("fails closed on conflicting history or missing 0062 objects before inserting", () => {
  const insert = sql.indexOf("INSERT INTO");
  for (const needle of [
    "hash = expected_hash",
    "created_at >= expected_when",
    "0062 tables are not all present",
    "0062 function % is missing",
    "callback events sequence is missing",
    "omni_dispatch_v3_action(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text)",
    "omni_dispatch_v3_pending_cancellations(uuid)",
    "omni_dispatch_v3_callback_record(text,uuid,uuid,uuid,uuid,text,text,text,jsonb)",
  ]) {
    const at = sql.indexOf(needle);
    assert.ok(at >= 0 && at < insert, `missing or late check: ${needle}`);
  }
  assert.match(sql, /RAISE EXCEPTION/);
});

test("expected jobs columns are the 12 columns declared by 0062", () => {
  const body = migration.slice(
    migration.indexOf("CREATE TABLE public.omni_dispatch_v3_jobs"),
    migration.indexOf("CREATE TABLE public.omni_dispatch_v3_callback_nonces"),
  );
  const cols = [...body.matchAll(/^ {2}([a-z_]+) (?:uuid|text|timestamptz|jsonb)\b/gm)].map((m) => m[1]);
  assert.equal(cols.length, 12);
  const listed = sql.match(/jobs_columns constant text\[\] := ARRAY\[([^\]]+)\]/)[1];
  const expected = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(expected, [...cols].sort());
});

test("sequence revoke is present, after the insert, and inside the transaction", () => {
  const revoke =
    "REVOKE ALL ON SEQUENCE public.omni_dispatch_v3_callback_events_id_seq\n  FROM PUBLIC, anon, authenticated;";
  assert.ok(sql.includes(revoke));
  assert.ok(sql.indexOf(revoke) > sql.indexOf("INSERT INTO"));
  assert.ok(sql.indexOf(revoke) < sql.indexOf("COMMIT;"));
});

test("journal still lists 0062 and the docs describe this file", async () => {
  assert.equal(entry.idx, 62);
  const doc = await read("docs/OMNI-DISPATCH-V3.md");
  assert.match(doc, /record-omni-dispatch-v3-0062-history\.sql/);
});

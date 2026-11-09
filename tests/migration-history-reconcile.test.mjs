// Regression guard for the 0055/0056 numbering clash (reconciled Nov 8 2026).
// Production's migration journal (drizzle.__drizzle_migrations, read-only) recorded these
// applied rows: 0054 chat, 0055 owner OMNI/JAX records, 0056 grant tightening. Main later
// reused "0055" for the OMNI access-expiry update, which production has NOT applied.
// The migrator applies only journal entries whose `when` is newer than the latest applied
// row, so the applied files must keep their exact bytes and timestamps, and the pending
// expiry update must stay strictly newer or it would be skipped silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const dir = new URL("../drizzle/migrations/", import.meta.url);
const journal = JSON.parse(await readFile(new URL("meta/_journal.json", dir), "utf8"));
const sha = async (tag) =>
  createHash("sha256").update(await readFile(new URL(`${tag}.sql`, dir), "utf8")).digest("hex");

// Rows read from production's journal on 2026-11-08 (hash = sha256 of the SQL file).
const appliedInProduction = [
  {
    tag: "0054_chat_threads_contexts_attachments",
    when: 1794098970048,
    hash: "cc21c101655d085c9668ae95ae79f8fb19286a278788569a9e4fb8a71adbca06",
  },
  {
    tag: "0055_owner_omni_handoffs_jax_manifests",
    when: 1794106108764,
    hash: "b468b533f78f7a926ce84982c662a221e7528a32ae5061077babe19eaed76e64",
  },
  {
    tag: "0056_owner_omni_jax_tighten_grants",
    when: 1794106131037,
    hash: "dbc85b86a00d109038a9a5b4c64faf4f6b37e6d9c74d2faee8b8f6e7d44964db",
  },
];
const latestApplied = Math.max(...appliedInProduction.map((r) => r.when));
const expiry = {
  tag: "0057_omni_authorization_expiry",
  when: 1794114805000,
  hash: "fadff300aff743b3f1a00f5d133fb5e4a8cdab5acc63489516b6534c6141922d",
};

test("journal timestamps strictly increase and idx is contiguous", () => {
  journal.entries.forEach((entry, i) => {
    assert.equal(entry.idx, i, `idx gap at ${entry.tag}`);
    if (i > 0) assert.ok(entry.when > journal.entries[i - 1].when, `${entry.tag} is not newer`);
  });
});

test("no two journal entries share a number prefix", () => {
  const prefixes = journal.entries.slice(44).map((e) => e.tag.slice(0, 4));
  assert.equal(new Set(prefixes).size, prefixes.length);
  for (const e of journal.entries.slice(44)) assert.equal(e.tag.slice(0, 4), String(e.idx).padStart(4, "0"));
});

test("every journal entry has its SQL file", async () => {
  const files = new Set(await readdir(dir));
  for (const e of journal.entries) assert.ok(files.has(`${e.tag}.sql`), `missing ${e.tag}.sql`);
});

test("production-applied migrations keep their exact bytes and timestamps", async () => {
  for (const row of appliedInProduction) {
    const entry = journal.entries.find((e) => e.tag === row.tag);
    assert.ok(entry, `journal lost ${row.tag}`);
    assert.equal(entry.when, row.when, `${row.tag} timestamp changed`);
    assert.equal(await sha(row.tag), row.hash, `${row.tag} SQL changed after being applied`);
  }
});

test("the access-expiry update stays unchanged and newer than the recorded applied baseline", async () => {
  const entry = journal.entries.find((e) => e.tag === expiry.tag);
  assert.ok(entry, "expiry update missing from journal");
  assert.ok(entry.when > latestApplied, "expiry update would be skipped by the migrator");
  assert.equal(entry.when, expiry.when);
  assert.equal(await sha(expiry.tag), expiry.hash);
  assert.equal(entry.idx, 57);
  assert.equal(journal.entries.filter((e) => e.tag.includes("omni_authorization_expiry")).length, 1);
});

test("the approval-save migration is appended after 0057 and links to the preceding snapshot", async () => {
  const entry = journal.entries.find((e) => e.tag === "0058_omni_link_approval_save");
  assert.ok(entry, "approval-save migration missing from journal");
  assert.equal(entry.idx, 58);
  assert.ok(entry.when > expiry.when);
  assert.ok(
    journal.entries.indexOf(entry) > journal.entries.findIndex((e) => e.tag === expiry.tag),
  );
  const [previous, current] = await Promise.all(
    ["0056", "0058"].map(async (n) =>
      JSON.parse(await readFile(new URL(`meta/${n}_snapshot.json`, dir), "utf8")),
    ),
  );
  assert.equal(current.prevId, previous.id);
});

test("snapshot chain for the restored entries links back to 0054", async () => {
  const snap = async (n) => JSON.parse(await readFile(new URL(`meta/${n}_snapshot.json`, dir), "utf8"));
  const [s54, s55, s56] = await Promise.all(["0054", "0055", "0056"].map(snap));
  assert.equal(s55.prevId, s54.id);
  assert.equal(s56.prevId, s55.id);
});

test("sync safety guards append after approval-save without rewriting its history", () => {
  const previous = journal.entries.find((e) => e.tag === "0058_omni_link_approval_save");
  const current = journal.entries.find((e) => e.tag === "0059_sync_safety_guards");
  assert.equal(current?.idx, 59);
  assert.ok(current.when > previous.when);
});

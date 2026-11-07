import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { supabaseStubs, migrationFiles } from "./helpers/staging-pg.mjs";

// In-memory PGlite only, synthetic IDs, no network. Replays the applied migration chain, then the
// PROPOSED, UNAPPLIED staging/code-sites/0050 multi-site pin migration.

const owner = "93a2e690-a179-4d08-bd68-a3a793fced11";
const stranger = "00000000-0000-4000-8000-000000000009";
const anchor = "OMERTA-ROW/jackboy-dev-control";
const site = "OMERTA-ROW/hercules-driver-os";
const sha = "37368194f883bc1cf5175aecf4832945203b602b";
const sha2 = "b".repeat(40);

let base;
const open = [];
const fresh = async () => { const c = await base.clone(); open.push(c); return c; };
after(async () => { for (const db of [...open, base]) await db?.close().catch(() => {}); });

before(async () => {
  base = new PGlite();
  await base.exec(supabaseStubs);
  for (const f of await migrationFiles()) await base.exec(await readFile(`drizzle/migrations/${f}`, "utf8"));
  await base.query("INSERT INTO auth.users(id, email) VALUES ($1, 'o@x.test'), ($2, 's@x.test')", [owner, stranger]);
  await base.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [owner]);
  await base.query("UPDATE public.code_runtime_controls SET allowed_targets = $1::jsonb", [JSON.stringify({ [anchor]: { ref: "main", workflowSha: sha } })]);
  await base.exec(await readFile("staging/code-sites/0050_code_site_pins.sql", "utf8"));
});

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const targets = async (db) => (await one(db, "SELECT allowed_targets AS t FROM public.code_runtime_controls")).t;
const pin = (db, repo, s, add, actor = owner) => db.query("SELECT public.set_code_site_pin($1, $2, $3, $4) AS t", [actor, repo, s, add]);
const audits = async (db, action) => (await one(db, "SELECT count(*)::int AS n FROM public.audit_logs WHERE action = $1", [action])).n;

test("the owner pins a second site on main; it is audited and the anchor stays", async () => {
  const db = await fresh();
  await pin(db, site, sha2, true);
  assert.deepEqual(await targets(db), { [anchor]: { ref: "main", workflowSha: sha }, [site]: { ref: "main", workflowSha: sha2 } });
  assert.equal(await audits(db, "code.site_pinned"), 1);
});

test("nobody but the owner can change the allow list (the app's readiness probe relies on this refusal)", async () => {
  const db = await fresh();
  await assert.rejects(pin(db, site, sha2, true, stranger), /Only the owner/);
  await assert.rejects(pin(db, "x/x", null, false, null), /Only the owner/);
  assert.equal(Object.keys(await targets(db)).length, 1);
});

test("direct writes to the allow list are refused; only set_code_site_pin may change it", async () => {
  const db = await fresh();
  await assert.rejects(db.query("UPDATE public.code_runtime_controls SET allowed_targets = '{}'::jsonb"), /set_code_site_pin/);
  await db.query("UPDATE public.code_runtime_controls SET updated_at = now()"); // other columns unaffected
});

test("the Jackboy anchor pin can't be added or removed here", async () => {
  const db = await fresh();
  await assert.rejects(pin(db, anchor, sha2, true), /anchor/);
  await assert.rejects(pin(db, anchor, null, false), /anchor/);
});

test("refuses bad input, mid-task changes and more than 10 sites", async () => {
  const db = await fresh();
  await assert.rejects(pin(db, site, "nothex", true), /Invalid workflow SHA/);
  await assert.rejects(pin(db, "not a repo", sha2, true), /Invalid repository/);
  await assert.rejects(pin(db, site, null, false), /not on the CODE allow list/);
  for (let i = 1; i <= 9; i++) await pin(db, `OMERTA-ROW/site-${i}`, sha2, true);
  await assert.rejects(pin(db, "OMERTA-ROW/site-10", sha2, true), /10 sites/);
  const busy = await fresh();
  await busy.query("ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER");
  await busy.query("UPDATE public.code_runtime_controls SET active_run_id = 1");
  await busy.query("ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER");
  await assert.rejects(pin(busy, site, sha2, true), /mid-task/);
});

test("removal takes the site off and keeps the history", async () => {
  const db = await fresh();
  await pin(db, site, sha2, true);
  await pin(db, site, null, false);
  assert.deepEqual(Object.keys(await targets(db)), [anchor]);
  assert.equal(await audits(db, "code.site_pinned"), 1);
  assert.equal(await audits(db, "code.site_unpinned"), 1);
});

test("the CODE on-switch accepts several valid pins but still refuses a malformed one", async () => {
  const db = await fresh();
  await pin(db, site, sha2, true);
  const r = (await one(db, "SELECT public.enable_code_runtime($1) AS r", [owner])).r;
  assert.ok(!r.reasons.includes("target_allowlist"), JSON.stringify(r.reasons));
  const bad = await fresh();
  await bad.query("ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER");
  await bad.query(`UPDATE public.code_runtime_controls SET allowed_targets = allowed_targets || '{"o/x": {"ref": "dev", "workflowSha": "${sha2}"}}'::jsonb`);
  await bad.query("ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER");
  const r2 = (await one(bad, "SELECT public.enable_code_runtime($1) AS r", [owner])).r;
  assert.ok(r2.reasons.includes("target_allowlist"));
});

test("rollback restores the single-site rules", async () => {
  const db = await fresh();
  await db.exec(await readFile("staging/code-sites/0050_code_site_pins.down.sql", "utf8"));
  await assert.rejects(pin(db, site, sha2, true), /does not exist/);
  await db.query("UPDATE public.code_runtime_controls SET updated_at = now(), allowed_targets = allowed_targets");
});

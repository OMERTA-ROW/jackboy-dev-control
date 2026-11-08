import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { supabaseStubs, migrationFiles } from "./helpers/staging-pg.mjs";

// In-memory PGlite only, synthetic IDs, no network. Replays the applied chain, then the PROPOSED,
// UNAPPLIED staging/code-lane/0051 automatic-lane switch.

const owner = "93a2e690-a179-4d08-bd68-a3a793fced11";
const stranger = "00000000-0000-4000-8000-000000000009";
const repo = "OMERTA-ROW/jackboy-dev-control";
const sha = "37368194f883bc1cf5175aecf4832945203b602b";
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
  await base.query("UPDATE public.code_runtime_controls SET allowed_targets = $1::jsonb", [JSON.stringify({ [repo]: { ref: "main", workflowSha: sha } })]);
  await base.exec(await readFile("staging/code-lane/0051_code_auto_lane.sql", "utf8"));
});

const set = (db, r, on, actor = owner) => db.query("SELECT public.set_code_auto_lane($1, $2, $3) AS r", [actor, r, on]);
const enabled = async (db, r) => (await db.query("SELECT enabled FROM public.code_auto_lane WHERE repo = $1", [r])).rows[0]?.enabled ?? false;

test("off by default; the owner turns it on for an allow-listed site and it is audited", async () => {
  const db = await fresh();
  assert.equal(await enabled(db, repo), false);
  await set(db, repo, true);
  assert.equal(await enabled(db, repo), true);
  assert.equal((await db.query("SELECT count(*)::int n FROM public.audit_logs WHERE action = 'code.auto_lane'")).rows[0].n, 1);
});

test("nobody else can change it", async () => {
  const db = await fresh();
  await assert.rejects(set(db, repo, true, stranger), /Only the owner/);
  await assert.rejects(set(db, repo, true, null), /Only the owner/);
});

test("refuses sites not on CODE, mid-task, and during a two-failure stop; turning off always works", async () => {
  const db = await fresh();
  await assert.rejects(set(db, "OMERTA-ROW/other", true), /allow list/);
  const busy = await fresh();
  await busy.query("ALTER TABLE public.code_runtime_controls DISABLE TRIGGER USER");
  await busy.query("UPDATE public.code_runtime_controls SET active_run_id = 1, consecutive_failures = 2");
  await busy.query("ALTER TABLE public.code_runtime_controls ENABLE TRIGGER USER");
  await assert.rejects(set(busy, repo, true), /mid-task|two-failure/);
  await set(busy, repo, false);
  assert.equal(await enabled(busy, repo), false);
});

test("rollback removes the switch", async () => {
  const db = await fresh();
  await set(db, repo, true);
  await db.exec(await readFile("staging/code-lane/0051_code_auto_lane.down.sql", "utf8"));
  await assert.rejects(db.query("SELECT 1 FROM public.code_auto_lane"), /does not exist/);
});

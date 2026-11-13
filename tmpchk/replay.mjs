import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { supabaseStubs, migrationFiles } from "/dev-server/tests/helpers/staging-pg.mjs";
process.chdir("/dev-server");
const t=Date.now();
const db = new PGlite();
await db.exec(supabaseStubs);
for (const f of await migrationFiles()) { try { await db.exec(await readFile(`drizzle/migrations/${f}`, "utf8")); } catch(e){ console.log("FAIL", f, e.message); throw e; } }
console.log("replayed in", Date.now()-t, "ms");
const names=['claim_code_runtime_slot','admit_code_provider_call','dispatch_code_provider_call','finish_code_runtime_slot','engage_code_kill_switch','enable_code_runtime','code_runtime_controls_activation_gate'];
const fs = await import("node:fs");
for (const n of names){ const r=(await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and proname=$1`,[n])).rows; fs.writeFileSync(`/tmp/chk/chain_${n}.sql`, r.map(x=>x.d).join("\n--\n")); console.log(n, r.length);}
console.log((await db.query("select to_jsonb(c) c from public.code_runtime_controls c")).rows[0]);
await db.close();

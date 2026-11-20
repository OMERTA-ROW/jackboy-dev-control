import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  skipNoPg,
  openDb,
  supabaseStubs,
  replay,
  setActivatedControls,
  closeAdmin,
} from "./helpers/staging-pg.mjs";

// Disposable loopback PostgreSQL only (STAGING_PG_URL). Proves the installed forward migration
// 0075_code_per_call_cap_050 (live history row 84) enforces the owner's $0.50 per-call limit at admission, keeps the
// $1 task reservation, and stays correct under concurrent admissions. Synthetic data only.
after(closeAdmin);

const installed = await readFile(
  new URL("../drizzle/migrations/0075_code_per_call_cap_050.sql", import.meta.url),
  "utf8",
);
const owner = randomUUID();
let seq = 0;
const key = () => `cap${String(++seq).padStart(8, "0")}`;

async function setup({ applyStaged = true } = {}) {
  const db = await openDb({ connections: 12 });
  await db.exec(supabaseStubs);
  await replay(db);
  if (applyStaged) await db.exec(`BEGIN;\n${installed}\nCOMMIT;`);
  await db.exec("UPDATE public.automation_policy SET paused=false WHERE id=1");
  await db.query("INSERT INTO auth.users(id, email) VALUES ($1, 'o@example.test')", [owner]);
  await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [owner]);
  const id = randomUUID();
  await db.query(
    `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt)
     VALUES ($1, 'code', 'high', 'n', now() + interval '1 hour', $2, 'allowed', now(), 7, 1)`,
    [id, owner],
  );
  // The live $1.00 per-job reservation.
  await db.query(
    `INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd, status) VALUES ($1, 7, 1.00, 'reserved')`,
    [id],
  );
  await setActivatedControls(
    db,
    "UPDATE public.code_runtime_controls SET enabled = true, kill_switch = false, active_request_id = $1, active_run_id = 7",
    [id],
  );
  return { db, id };
}
const admit = (db, id, ceiling) =>
  db.query("SELECT public.admit_code_provider_call($1, 7, $2, 'm-test', $3) AS id", [
    id,
    key(),
    ceiling,
  ]);
const count = async (db) =>
  (await db.query("SELECT count(*)::int n FROM public.code_provider_calls")).rows[0].n;

test("the replayed migration set already refuses a single $0.75 call", { skip: skipNoPg }, async () => {
  const { db, id } = await setup({ applyStaged: false });
  try {
    await assert.rejects(admit(db, id, 0.75), /invalid request/);
    assert.equal(await count(db), 0);
  } finally {
    await db.close();
  }
});

test("installed: exactly $0.50 is admitted, $0.500001 and $0.75 are refused", { skip: skipNoPg }, async () => {
  const { db, id } = await setup();
  try {
    await admit(db, id, 0.5);
    await assert.rejects(admit(db, id, 0.500001), /invalid request/);
    await assert.rejects(admit(db, id, 0.75), /invalid request/);
    assert.equal(await count(db), 1);
  } finally {
    await db.close();
  }
});

test("installed: the $1 job reservation still bounds the total (third $0.50 call refused)", { skip: skipNoPg }, async () => {
  const { db, id } = await setup();
  try {
    await admit(db, id, 0.5);
    await admit(db, id, 0.5);
    await assert.rejects(admit(db, id, 0.5), /reservation would be exceeded/);
    assert.equal(await count(db), 2);
  } finally {
    await db.close();
  }
});

test("installed: 10 concurrent $0.50 admissions on a $1 job admit exactly 2", { skip: skipNoPg }, async () => {
  const { db, id } = await setup();
  try {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => admit(db, id, 0.5)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(await count(db), 2);
  } finally {
    await db.close();
  }
});

test("installed: installs atomically and keeps owner-only execution", { skip: skipNoPg }, async () => {
  const { db } = await setup();
  try {
    const row = (
      await db.query(
        `SELECT prosecdef, array_to_string(proconfig, ',') cfg, position('p_ceiling_usd > 0.50' IN prosrc) > 0 has_check,
           has_function_privilege('authenticated', oid, 'EXECUTE') auth_exec,
           has_function_privilege('anon', oid, 'EXECUTE') anon_exec
         FROM pg_proc WHERE oid = 'public.admit_code_provider_call(uuid,bigint,text,text,numeric)'::regprocedure`,
      )
    ).rows[0];
    assert.equal(row.prosecdef, true);
    assert.equal(row.cfg, 'search_path=""');
    assert.equal(row.has_check, true);
    assert.equal(row.auth_exec, false);
    assert.equal(row.anon_exec, false);
  } finally {
    await db.close();
  }
});

test("installed: fails closed — Kill Switch on, CODE off, no reservation, null/zero/negative ceiling all refuse", { skip: skipNoPg }, async () => {
  const { db, id } = await setup();
  try {
    await assert.rejects(admit(db, id, null), /invalid request/);
    await assert.rejects(admit(db, id, 0), /invalid request/);
    await assert.rejects(admit(db, id, -0.1), /invalid request/);
    await setActivatedControls(db, "UPDATE public.code_runtime_controls SET kill_switch = true", []);
    await assert.rejects(admit(db, id, 0.5), /not authorised/);
    await setActivatedControls(db, "UPDATE public.code_runtime_controls SET kill_switch = false, enabled = false", []);
    await assert.rejects(admit(db, id, 0.5), /not authorised/);
    await setActivatedControls(db, "UPDATE public.code_runtime_controls SET enabled = true", []);
    // A task with no spend reservation is refused even when it holds the runtime slot.
    const bare = randomUUID();
    await db.query(
      `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt)
       VALUES ($1, 'code', 'high', 'n', now() + interval '1 hour', $2, 'allowed', now(), 7, 1)`,
      [bare, owner],
    );
    await setActivatedControls(db, "UPDATE public.code_runtime_controls SET active_request_id = $1", [bare]);
    await assert.rejects(admit(db, bare, 0.5), /no active spend reservation/);
    assert.equal(await count(db), 0);
  } finally {
    await db.close();
  }
});

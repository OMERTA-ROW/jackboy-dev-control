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

// Real-PostgreSQL migration-chain replay (loopback disposable server only; see helpers/staging-pg.mjs).
after(closeAdmin);

const baseline = "0030_repository_resync_baseline.sql";
const fingerprint = async (db) =>
  (
    await db.query(`
      SELECT p.oid::regprocedure::text AS sig, md5(pg_get_functiondef(p.oid)) AS body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (p.proname LIKE '%repository_resync%' OR p.proname = 'repository_reference_inventory'
             OR p.proname LIKE 'guard_repository%' OR p.proname LIKE 'reset_resynced%')
      ORDER BY 1`)
  ).rows;

test(
  "local-only staging SQL refuses real PostgreSQL without changing the hard-cap gate",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      await replay(db);
      for (const file of ["code-local-staging-up.sql", "code-local-staging-down.sql"]) {
        await assert.rejects(
          db.exec(await readFile(`tests/fixtures/${file}`, "utf8")),
          /requires PGlite/,
        );
      }
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
        /only be set by set_code_provider_hard_cap_verified/,
      );
      assert.equal(
        (await db.query("SELECT provider_hard_cap_verified FROM public.code_runtime_controls")).rows[0]
          .provider_hard_cap_verified,
        false,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "the full-chain hard-cap gate requires an owner, an intact guard, and a stopped runtime",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      await replay(db);
      const owner = randomUUID();
      const stranger = randomUUID();
      await db.query("INSERT INTO auth.users(id) VALUES ($1), ($2)", [owner, stranger]);
      await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [owner]);
      const attest = (actor) =>
        db.query("SELECT public.set_code_provider_hard_cap_verified($1, true, $2)", [
          actor,
          "Reviewed guard evidence for test",
        ]);
      await assert.rejects(attest(stranger), /Only the owner/);
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET kill_switch = false"),
        /Emergency Stop released only through release_code_emergency_stop/,
      );
      await setActivatedControls(db, "UPDATE public.code_runtime_controls SET kill_switch = false");
      await assert.rejects(attest(owner), /disabled and stopped/);
      await db.query("UPDATE public.code_runtime_controls SET kill_switch = true");
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET kill_switch = false"),
        /Emergency Stop released only through release_code_emergency_stop/,
      );
      await db.exec("ALTER TABLE public.code_usage_events DISABLE TRIGGER code_usage_events_total_guard");
      await assert.rejects(attest(owner), /not enforced/);
      await db.exec("ALTER TABLE public.code_usage_events ENABLE TRIGGER code_usage_events_total_guard");
      await attest(owner);
      const { rows } = await db.query(`
        SELECT provider_hard_cap_verified, enabled, kill_switch,
               (SELECT count(*)::int FROM public.audit_logs WHERE action = 'code.hard_cap_verified') AS audits,
               has_function_privilege('authenticated', 'public.set_code_provider_hard_cap_verified(uuid,boolean,text)', 'EXECUTE') AS auth_can_attest
        FROM public.code_runtime_controls`);
      assert.deepEqual(rows[0], {
        provider_hard_cap_verified: true,
        enabled: false,
        kill_switch: true,
        audits: 1,
        auth_can_attest: false,
      });
    } finally {
      await db.close();
    }
  },
);

test(
  "an empty database replays the full chain through the hard-cap gate (fresh install)",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      const applied = await replay(db);
      assert.ok(applied.includes(baseline));
      assert.ok(applied.includes("0042_code_provider_gateway.sql"));
      assert.ok(applied.includes("0045_omni_dispatch_grants.sql"));
      assert.ok(applied.includes("0047_code_hard_cap_gate.sql"));
      assert.ok(
        applied.indexOf("0048_code_spend_meter_and_activation.sql") >
          applied.indexOf("0047_code_hard_cap_gate.sql"),
      );
      assert.ok(applied.indexOf(baseline) > applied.indexOf("0030_omni_sessions.sql"));
      assert.ok(
        applied.indexOf(baseline) < applied.indexOf("0031_repository_resync_drift_removals.sql"),
      );
      const { rows } = await db.query(`
      SELECT to_regclass('public.repository_resync_reviews') AS reviews,
             to_regprocedure('public.apply_repository_resync(uuid,uuid,jsonb)') AS wrapper,
             to_regprocedure('public.apply_project_repository_resync(uuid,uuid,jsonb)') AS project_fn,
             (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('repository_resync_bound_work','repository_resync_actions_access')) AS triggers,
             (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'repository_resync_reviews' AND column_name IN ('report','invalidated')) AS drift_cols`);
      assert.deepEqual(rows[0], {
        reviews: "repository_resync_reviews",
        wrapper: "apply_repository_resync(uuid,uuid,jsonb)",
        project_fn: "apply_project_repository_resync(uuid,uuid,jsonb)",
        triggers: 2,
        drift_cols: 2,
      });
      // The placeholder must have been superseded by the real 0031 body.
      const body = (
        await db.query(
          "SELECT pg_get_functiondef('public.apply_repository_resync_internal(uuid,uuid,jsonb)'::regprocedure) AS d",
        )
      ).rows[0].d;
      assert.doesNotMatch(body, /placeholder/);
      const cap = await db.query(`
        SELECT provider_hard_cap_verified, enabled, kill_switch,
               public.code_total_spend_guard_enforced() AS guard_enforced
        FROM public.code_runtime_controls`);
      assert.deepEqual(cap.rows[0], {
        provider_hard_cap_verified: false,
        enabled: false,
        kill_switch: true,
        guard_enforced: true,
      });
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
        /only be set by set_code_provider_hard_cap_verified/,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "without the baseline the old gap reproduces (proves the fix is what closes it)",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      await assert.rejects(replay(db, { skip: [baseline] }), (e) => {
        assert.equal(e.migration, "0031_repository_resync_drift_removals.sql");
        assert.match(e.message, /repository_resync_reviews/);
        return true;
      });
    } finally {
      await db.close();
    }
  },
);

test(
  "upgrade compatibility: re-applying the baseline is a no-op and never alters existing objects",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      await replay(db);
      const before = await fingerprint(db);
      await db.query(
        "INSERT INTO public.repository_resync_reviews(requested_by, inventory, references_snapshot) VALUES (gen_random_uuid(), '[]', '[]')",
      );
      await db.exec(await readFile(`drizzle/migrations/${baseline}`, "utf8"));
      await db.exec(await readFile(`drizzle/migrations/${baseline}`, "utf8"));
      assert.deepEqual(await fingerprint(db), before);
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM public.repository_resync_reviews")).rows[0]
          .n,
        1,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "upgrade compatibility: a database that already has divergent resync objects keeps them untouched",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      await replay(db, { through: "0030", skip: [baseline] });
      // Simulate an environment (e.g. production) that already carries the objects with its own bodies.
      await db.exec(`
      CREATE TABLE public.repository_resync_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requested_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
        inventory jsonb NOT NULL, references_snapshot jsonb NOT NULL, approved_at timestamptz, replacements jsonb, marker text DEFAULT 'prod');
      INSERT INTO public.repository_resync_reviews(requested_by, inventory, references_snapshot) VALUES (gen_random_uuid(), '[]', '[]');
      CREATE FUNCTION public.guard_repository_resync_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN /* prod-marker */ RETURN NEW; END $$;
      CREATE FUNCTION public.apply_repository_resync_internal(uuid, uuid, jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"prod":true}'::jsonb $$;`);
      const before = await fingerprint(db);
      await db.exec(await readFile(`drizzle/migrations/${baseline}`, "utf8"));
      const after = await fingerprint(db);
      for (const keep of [
        "guard_repository_resync_target()",
        "apply_repository_resync_internal(uuid,uuid,jsonb)",
      ]) {
        assert.deepEqual(
          after.find((r) => r.sig.includes(keep)),
          before.find((r) => r.sig.includes(keep)),
          keep,
        );
      }
      assert.equal(
        (await db.query("SELECT marker FROM public.repository_resync_reviews")).rows[0].marker,
        "prod",
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM public.repository_resync_reviews")).rows[0]
          .n,
        1,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "a failing migration rolls back atomically and the chain can resume after repair",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      await replay(db, { through: "0039" });
      await db.exec("CREATE TABLE public.code_spend_reservations (blocker int)");
      await assert.rejects(replay(db, { from: "0040" }), (e) => e.migration?.startsWith("0040"));
      assert.equal(
        (
          await db.query(
            "SELECT to_regprocedure('public.reconcile_code_spend_reservations(uuid)') AS f",
          )
        ).rows[0].f,
        null,
      );
      await db.exec("DROP TABLE public.code_spend_reservations");
      await replay(db, { from: "0040" });
      assert.ok(
        (await db.query("SELECT to_regclass('public.code_spend_reservations') AS t")).rows[0].t,
      );
      assert.equal(
        (await db.query("SELECT to_regclass('public.omni_dispatch_grants') AS t")).rows[0].t,
        "omni_dispatch_grants",
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "rolling back the cap gate and guard before 0042, 0041 and 0040 restores 0037",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      await replay(db);
      await db.exec(
        await readFile("staging/code-activation/0048_code_hard_cap_gate.down.sql", "utf8"),
      );
      await db.exec(
        await readFile("staging/code-activation/0047_code_total_spend_guard.down.sql", "utf8"),
      );
      await db.exec(
        await readFile("drizzle/rollbacks/0042_code_provider_gateway.down.sql", "utf8"),
      );
      await db.exec(
        await readFile("drizzle/rollbacks/0041_code_spend_hold_release.down.sql", "utf8"),
      );
      await db.exec(
        await readFile("drizzle/rollbacks/0040_code_spend_reservations.down.sql", "utf8"),
      );
      const gone = await db.query(
        "SELECT to_regclass('public.code_spend_reservations') AS t, (SELECT count(*)::int FROM pg_constraint WHERE conname = 'code_runtime_controls_provider_hard_cap_verified_check') AS cap",
      );
      assert.deepEqual(gone.rows[0], { t: null, cap: 1 });
      await replay(db, { from: "0040", through: "0042" });
      assert.ok(
        (await db.query("SELECT to_regclass('public.code_spend_reservations') AS t")).rows[0].t,
      );
      assert.equal(
        (await db.query("SELECT to_regclass('public.omni_dispatch_grants') AS t")).rows[0].t,
        "omni_dispatch_grants",
      );
      await replay(db, { from: "0046", through: "0047" });
      assert.equal(
        (await db.query("SELECT public.code_total_spend_guard_enforced() AS enforced")).rows[0]
          .enforced,
        true,
      );
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
        /only be set by set_code_provider_hard_cap_verified/,
      );
    } finally {
      await db.close();
    }
  },
);

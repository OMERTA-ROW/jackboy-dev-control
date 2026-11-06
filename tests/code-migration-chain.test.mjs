import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { skipNoPg, openDb, supabaseStubs, replay, closeAdmin } from "./helpers/staging-pg.mjs";

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
  "local-only staging SQL refuses real PostgreSQL without changing the cap constraint",
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
        /check constraint/i,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "an empty database replays the full chain through scoped dispatch (fresh install)",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      const applied = await replay(db);
      assert.ok(applied.includes(baseline));
      assert.ok(applied.includes("0042_code_provider_gateway.sql"));
      assert.equal(applied.at(-1), "0045_omni_dispatch_grants.sql");
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
      const cap = await db.query(
        "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'code_runtime_controls_provider_hard_cap_verified_check'",
      );
      assert.equal(cap.rows[0].n, 1, "0037 hard-cap CHECK present after full replay");
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
        /check constraint/i,
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
  "rollback of 0042, 0041 then 0040 on the full chain restores 0037 and the chain re-applies",
  { skip: skipNoPg },
  async () => {
    const db = await openDb();
    try {
      await db.exec(supabaseStubs);
      await replay(db);
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
    } finally {
      await db.close();
    }
  },
);

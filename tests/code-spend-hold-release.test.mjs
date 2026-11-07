import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { skipNoPg, openDb, supabaseStubs, replay, closeAdmin } from "./helpers/staging-pg.mjs";

// Real-PostgreSQL tests for 0041 owner-authorised hold release (loopback disposable server only).
after(closeAdmin);

const owner = randomUUID();
const stranger = randomUUID();

async function setup({ through } = {}) {
  const db = await openDb();
  await db.exec(supabaseStubs);
  await replay(db, through ? { through } : {});
  await db.query(
    "INSERT INTO auth.users(id, email) VALUES ($1, 'o@example.test'), ($2, 's@example.test')",
    [owner, stranger],
  );
  await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [owner]);
  return db;
}

const ts = (daysAgo, hour) =>
  `(((now() AT TIME ZONE 'UTC')::date - ${daysAgo})::timestamp + interval '${hour} hours')`;

// Finished hold whose life spans the given UTC offsets (days ago, hour).
async function hold(
  db,
  { from = [3, 23], to = [2, 1], status = "finished", outcome = "success" } = {},
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO public.action_requests (id, action, tier, nonce_hash, expires_at, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt)
     VALUES ($1, 'code', 'high', 'n', now() + interval '1 hour', $2, 'allowed', now(), 1, 1)`,
    [id, owner],
  );
  const created = `${ts(...from)} AT TIME ZONE 'UTC'`;
  const fin = status === "reserved" ? "NULL" : `${ts(...to)} AT TIME ZONE 'UTC'`;
  await db.query(
    `INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd, status, outcome, created_at, finished_at)
     VALUES ($1, 1, 2, $2, $3, ${created}, ${fin})`,
    [id, status, status === "reserved" ? null : outcome],
  );
  return id;
}

const dayRow = (daysAgo) =>
  `SELECT to_char(d AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, d::timestamptz AS start FROM (SELECT ((now() AT TIME ZONE 'UTC')::date - ${daysAgo})::timestamp AT TIME ZONE 'UTC' AS d) x`;

async function report(
  db,
  daysAgo,
  { actor = owner, syncedSql = "now() - interval '12 hours'", rows } = {},
) {
  const day = (await db.query(dayRow(daysAgo))).rows[0];
  const payload = rows ?? [
    {
      provider_event_id: `${daysAgo}`.padStart(2, "0").repeat(32),
      source: "openai_org_costs",
      occurred_at: day.start,
      cost_usd: 0.5,
      request_id: null,
    },
  ];
  return db.query(
    `SELECT public.record_code_closed_day_costs($1, $2::date, $3::jsonb, ${syncedSql}) AS id`,
    [actor, day.d, JSON.stringify(payload)],
  );
}

const release = (db, ids, actor = owner, reason = "provider usage verified for task") =>
  db.query("SELECT public.release_code_spend_holds($1, $2::uuid[], $3) AS n", [actor, ids, reason]);
const status = async (db, id) =>
  (
    await db.query(
      "SELECT status, released_usd::float AS released FROM public.code_spend_reservations WHERE request_id = $1",
      [id],
    )
  ).rows[0];
const audit = async (db, action) =>
  (await db.query("SELECT count(*)::int AS n FROM public.audit_logs WHERE action = $1", [action]))
    .rows[0].n;

test(
  "a date change alone never releases a cross-day hold, and reconcile still leaves it reserved",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      const id = await hold(db);
      await db.query("UPDATE public.code_runtime_controls SET provider_costs_synced_at = now()");
      await db.query("SELECT public.reconcile_code_spend_reservations($1)", [owner]);
      assert.equal((await status(db, id)).status, "finished");
      await assert.rejects(release(db, [id]), /no authoritative provider cost evidence/);
      assert.equal((await status(db, id)).status, "finished");
    } finally {
      await db.close();
    }
  },
);

test(
  "release requires closed-day evidence for EVERY touched day; partial evidence keeps it reserved",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      const id = await hold(db);
      await report(db, 3);
      await assert.rejects(release(db, [id]), /UTC day/);
      assert.equal((await status(db, id)).status, "finished");
      await report(db, 2);
      assert.equal((await release(db, [id])).rows[0].n, 1);
      assert.deepEqual(await status(db, id), { status: "settled", released: 2 });
      assert.equal(await audit(db, "code.spend_holds_released"), 1);
    } finally {
      await db.close();
    }
  },
);

test(
  "delayed or stale evidence is rejected: report before finish+grace, or recorded before day close+lag",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      // Report for a day that has not closed (today) is invalid.
      await assert.rejects(report(db, 0), /Invalid closed-day/);
      // Report recorded too soon after the day ended (before the configured lag).
      await assert.rejects(
        report(db, 1, {
          syncedSql:
            "(((now() AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC') + interval '1 hour'",
        }),
        /Invalid closed-day/,
      );
      // Report synced before the task finished does not cover it.
      const id = await hold(db, { from: [3, 23], to: [2, 20] });
      await report(db, 3, { syncedSql: `(${ts(2, 7)}) AT TIME ZONE 'UTC'` });
      await report(db, 2, { syncedSql: `(${ts(1, 7)}) AT TIME ZONE 'UTC'` });
      // day 3 evidence (synced day-2 05:00) predates finish (day-2 20:00 + grace) -> still reserved
      await assert.rejects(release(db, [id]), /UTC day/);
      assert.equal((await status(db, id)).status, "finished");
    } finally {
      await db.close();
    }
  },
);

test(
  "unavailable usage data: unfinished, cancelled-without-report and missing holds stay reserved",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      const running = await hold(db, { status: "reserved" });
      await assert.rejects(release(db, [running]), /not finished/);
      const cancelled = await hold(db, { outcome: "cancelled" });
      await assert.rejects(release(db, [cancelled]), /stays reserved/);
      await assert.rejects(release(db, [randomUUID()]), /does not exist/);
      assert.equal((await status(db, running)).status, "reserved");
      assert.equal((await status(db, cancelled)).status, "finished");
      assert.equal(await audit(db, "code.spend_holds_released"), 0);
    } finally {
      await db.close();
    }
  },
);

test(
  "a cancelled hold releases only after the same authoritative evidence",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      const id = await hold(db, { outcome: "cancelled" });
      await report(db, 3);
      await report(db, 2);
      assert.equal((await release(db, [id])).rows[0].n, 1);
    } finally {
      await db.close();
    }
  },
);

test(
  "release is all-or-nothing: one unevidenced hold rolls back the others",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      const covered = await hold(db, { from: [3, 5], to: [3, 6] });
      const uncovered = await hold(db, { from: [3, 23], to: [2, 1] });
      await report(db, 3);
      await assert.rejects(release(db, [covered, uncovered]), /UTC day/);
      assert.equal((await status(db, covered)).status, "finished");
      assert.equal(await audit(db, "code.spend_holds_released"), 0);
      assert.equal((await release(db, [covered])).rows[0].n, 1);
    } finally {
      await db.close();
    }
  },
);

test(
  "duplicate and concurrent release settle once with one audit row each",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      const id = await hold(db, { from: [3, 5], to: [3, 6] });
      await report(db, 3);
      const results = await Promise.all(Array.from({ length: 6 }, () => release(db, [id])));
      assert.equal(
        results.reduce((s, r) => s + r.rows[0].n, 0),
        1,
        "exactly one call settles",
      );
      assert.equal(await audit(db, "code.spend_holds_released"), 6, "every call is audited");
      const again = await release(db, [id]);
      assert.equal(again.rows[0].n, 0);
      assert.deepEqual(await status(db, id), { status: "settled", released: 2 });
    } finally {
      await db.close();
    }
  },
);

test(
  "only the owner may record evidence or release; invalid requests are rejected",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      const id = await hold(db, { from: [3, 5], to: [3, 6] });
      await assert.rejects(report(db, 3, { actor: stranger }), /Only the owner/);
      await report(db, 3);
      await assert.rejects(release(db, [id], stranger), /Only the owner/);
      await assert.rejects(release(db, [id], owner, "short"), /Invalid/);
      await assert.rejects(release(db, [id, id]), /Invalid/);
      await assert.rejects(release(db, []), /Invalid/);
      await assert.rejects(
        db.query(
          "SELECT public.release_code_spend_holds(NULL, ARRAY[$1]::uuid[], 'a valid reason')",
          [id],
        ),
        /Only the owner/,
      );
      assert.equal((await status(db, id)).status, "finished");
      await assert.rejects(
        db
          .query("SELECT set_config('role','authenticated',false)")
          .then(() =>
            db.query(
              "SELECT public.release_code_spend_holds($1, ARRAY[$2]::uuid[], 'a valid reason')",
              [owner, id],
            ),
          ),
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "evidence is append-only; malformed reports are rejected without side effects",
  { skip: skipNoPg },
  async () => {
    const db = await setup();
    try {
      await report(db, 3);
      await assert.rejects(
        db.query("UPDATE public.code_provider_cost_day_reports SET reported_cost_usd = 0"),
        /append-only/,
      );
      await assert.rejects(
        db.query("DELETE FROM public.code_provider_cost_day_reports"),
        /append-only/,
      );
      const day = (await db.query(dayRow(2))).rows[0];
      const bad = [
        {
          provider_event_id: "zz",
          source: "openai_org_costs",
          occurred_at: day.start,
          cost_usd: 1,
          request_id: null,
        },
      ];
      const before = (await db.query("SELECT count(*)::int n FROM public.code_usage_events"))
        .rows[0].n;
      await assert.rejects(report(db, 2, { rows: bad }), /invalid or out-of-day/);
      await assert.rejects(report(db, 2, { rows: [] }), /Invalid closed-day/);
      const wrongDay = [
        {
          provider_event_id: "ab".repeat(32),
          source: "openai_org_costs",
          occurred_at: (await db.query(dayRow(5))).rows[0].start,
          cost_usd: 1,
          request_id: null,
        },
      ];
      await assert.rejects(report(db, 2, { rows: wrongDay }), /invalid or out-of-day/);
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM public.code_usage_events")).rows[0].n,
        before,
      );
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM public.code_provider_cost_day_reports"))
          .rows[0].n,
        1,
      );
    } finally {
      await db.close();
    }
  },
);

test("audit-log failure rolls the release back (fail closed)", { skip: skipNoPg }, async () => {
  const db = await setup();
  try {
    const id = await hold(db, { from: [3, 5], to: [3, 6] });
    await report(db, 3);
    await db.query(
      `CREATE FUNCTION public.deny_release_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'code.spend_holds_released' THEN RAISE EXCEPTION 'audit sink down'; END IF; RETURN NEW; END; $$`,
    );
    await db.query(
      "CREATE TRIGGER deny_release_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.deny_release_audit()",
    );
    await assert.rejects(release(db, [id]), /audit sink down/);
    assert.equal((await status(db, id)).status, "finished");
    await db.query("DROP TRIGGER deny_release_audit ON public.audit_logs");
    assert.equal((await release(db, [id])).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test(
  "a released hold stops counting; the 0037 hard-cap CHECK stays intact and 0041 rollback/re-apply works",
  { skip: skipNoPg },
  async () => {
    const db = await setup({ through: "0045" });
    try {
      const id = await hold(db, { from: [3, 5], to: [3, 6] });
      const open = () =>
        db
          .query(
            "SELECT coalesce(sum(reserved_usd),0)::float s FROM public.code_spend_reservations WHERE status <> 'settled'",
          )
          .then((r) => r.rows[0].s);
      assert.equal(await open(), 2);
      await report(db, 3);
      await release(db, [id]);
      assert.equal(await open(), 0);
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
        /check constraint/i,
      );

      const fs = await import("node:fs/promises");
      const down = await fs.readFile(
        new URL("../drizzle/rollbacks/0041_code_spend_hold_release.down.sql", import.meta.url),
        "utf8",
      );
      const up = await fs.readFile(
        new URL("../drizzle/migrations/0041_code_spend_hold_release.sql", import.meta.url),
        "utf8",
      );
      // Rollback refuses while an unsettled hold exists.
      const open2 = await hold(db, { from: [3, 5], to: [3, 6] });
      await assert.rejects(db.query(down), /Unsettled/);
      await db.query(
        "UPDATE public.code_spend_reservations SET status='settled', released_usd=reserved_usd, settled_at=now() WHERE request_id=$1",
        [open2],
      );
      await db.query(down);
      assert.equal(
        (await db.query("SELECT to_regclass('public.code_provider_cost_day_reports') AS t")).rows[0]
          .t,
        null,
      );
      await assert.rejects(
        db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
        /check constraint/i,
      );
      await db.query(up);
      assert.equal(
        (await db.query("SELECT to_regclass('public.code_provider_cost_day_reports') AS t")).rows[0]
          .t,
        "code_provider_cost_day_reports",
      );
    } finally {
      await db.close();
    }
  },
);

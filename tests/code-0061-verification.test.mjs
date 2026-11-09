import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { closeAdmin, openDb, replay, skipNoPg, supabaseStubs } from "./helpers/staging-pg.mjs";

after(closeAdmin);
const verification = await readFile("drizzle/migrations/0061_verify_0059_0060_install.sql", "utf8");
const signature = "public.set_guardian_limits(integer,integer,integer)";

test("potentially applied 0061 keeps the exact source bytes and journal timestamp", async () => {
  assert.equal(
    createHash("sha256").update(verification).digest("hex"),
    "a104a54f80beaed3de6ef2566d1f0cc42e7807b76581c4b42fbb2d9f5641263f",
  );
  const journal = JSON.parse(await readFile("drizzle/migrations/meta/_journal.json", "utf8"));
  const entry = journal.entries.find((item) => item.tag === "0061_verify_0059_0060_install");
  assert.equal(entry?.idx, 61);
  assert.equal(entry?.when, 1794234033152);
});

async function fixture() {
  const db = await openDb();
  try {
    await db.exec(supabaseStubs);
    await replay(db, { through: "0060" });
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function rejectedTamper(db, sql, reason) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await assert.rejects(client.query(verification), reason);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test(
  "0061 accepts production-named ownership and preserves stopped state",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const before = (
        await db.query("SELECT to_jsonb(c) AS state FROM public.code_runtime_controls c")
      ).rows;
      await db.exec(verification);
      assert.deepEqual(
        (await db.query("SELECT to_jsonb(c) AS state FROM public.code_runtime_controls c")).rows,
        before,
      );
      assert.equal(
        (
          await db.query(
            "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure",
            [signature],
          )
        ).rows[0].owner,
        "postgres",
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "0061 still rejects wrong ownership, unsafe grants and disabled guard",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      await rejectedTamper(
        db,
        `ALTER FUNCTION ${signature} OWNER TO authenticated`,
        /Post-install check failed/,
      );
      await rejectedTamper(
        db,
        "GRANT EXECUTE ON FUNCTION public.code_acceptance_guard_status() TO authenticated",
        /Post-install permission check failed/,
      );
      await rejectedTamper(
        db,
        "GRANT EXECUTE ON FUNCTION public.code_acceptance_guard_status() TO PUBLIC",
        /Post-install check failed/,
      );
      await rejectedTamper(
        db,
        "ALTER TABLE public.code_spend_reservations DISABLE TRIGGER code_acceptance_reservation_guard",
        /Acceptance reservation trigger is missing/,
      );
      await db.exec(verification);
    } finally {
      await db.close();
    }
  },
);

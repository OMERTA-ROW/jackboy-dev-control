import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE user_roles(user_id uuid, role text);
  CREATE TABLE omni_project_authorizations(
    id uuid PRIMARY KEY, project_id uuid NOT NULL, owner_id uuid NOT NULL,
    expires_at timestamptz NOT NULL, revoked_at timestamptz, revoked_reason text
  );
  CREATE TABLE omni_dispatch_grants(
    id uuid PRIMARY KEY, authorization_id uuid REFERENCES omni_project_authorizations(id),
    expires_at timestamptz NOT NULL, revoked_at timestamptz
  );
  CREATE TABLE site_log(
    actor text, action text, category text, status text, summary text,
    project_id uuid, detail jsonb
  );
`);
await db.exec(
  await readFile(
    new URL("../drizzle/migrations/0055_omni_authorization_expiry.sql", import.meta.url),
    "utf8",
  ),
);
const owner = "11111111-1111-4111-8111-111111111111";
const other = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project = "22222222-2222-4222-8222-222222222222";
const expiredAuthorization = "33333333-3333-4333-8333-333333333333";
const activeAuthorization = "44444444-4444-4444-8444-444444444444";
const grantForExpiredAuth = "55555555-5555-4555-8555-555555555555";
const expiredGrant = "66666666-6666-4666-8666-666666666666";
const activeGrant = "77777777-7777-4777-8777-777777777777";

beforeEach(async () => {
  await db.exec("TRUNCATE site_log, omni_dispatch_grants, omni_project_authorizations, user_roles");
  await db.query("INSERT INTO user_roles VALUES ($1,'owner')", [owner]);
  await db.query(
    "INSERT INTO omni_project_authorizations VALUES ($1,$2,$3,now()-interval '1 second',NULL,NULL),($4,$2,$3,now()+interval '1 day',NULL,NULL)",
    [expiredAuthorization, project, owner, activeAuthorization],
  );
  await db.query(
    "INSERT INTO omni_dispatch_grants VALUES ($1,$2,now()+interval '1 day',NULL),($3,$4,now()-interval '1 second',NULL),($5,$4,now()+interval '1 day',NULL)",
    [grantForExpiredAuth, expiredAuthorization, expiredGrant, activeAuthorization, activeGrant],
  );
});

after(() => db.close());

const expire = (actor = owner) =>
  db.query("SELECT expire_omni_project_authorizations($1) AS result", [actor]);

test("records expired project access, revokes dependent and expired job grants, and is idempotent", async () => {
  const result = (await expire()).rows[0].result;
  assert.deepEqual(result, { expiredAuthorizations: 1, expiredJobApprovals: 2 });
  assert.equal(
    (await db.query("SELECT revoked_reason FROM omni_project_authorizations WHERE id=$1", [expiredAuthorization])).rows[0].revoked_reason,
    "expired",
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM omni_dispatch_grants WHERE revoked_at IS NOT NULL")).rows[0].n,
    2,
  );
  assert.equal(
    (await db.query("SELECT revoked_at FROM omni_dispatch_grants WHERE id=$1", [activeGrant])).rows[0].revoked_at,
    null,
  );
  assert.equal((await db.query("SELECT count(*)::int AS n FROM site_log")).rows[0].n, 2);
  assert.deepEqual((await expire()).rows[0].result, { expiredAuthorizations: 0, expiredJobApprovals: 0 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM site_log")).rows[0].n, 2);
});

test("refuses a caller that is not the owner", async () => {
  await assert.rejects(expire(other), /Owner required/);
  assert.equal(
    (await db.query("SELECT revoked_at FROM omni_project_authorizations WHERE id=$1", [expiredAuthorization])).rows[0].revoked_at,
    null,
  );
});

test("audit failure rolls back expiration and grant revocation", async () => {
  await db.exec("ALTER TABLE site_log ADD CONSTRAINT refuse_expiry_audit CHECK (false) NOT VALID");
  try {
    await assert.rejects(expire());
    assert.equal(
      (await db.query("SELECT revoked_at FROM omni_project_authorizations WHERE id=$1", [expiredAuthorization])).rows[0].revoked_at,
      null,
    );
    assert.equal(
      (await db.query("SELECT revoked_at FROM omni_dispatch_grants WHERE id=$1", [grantForExpiredAuth])).rows[0].revoked_at,
      null,
    );
  } finally {
    await db.exec("ALTER TABLE site_log DROP CONSTRAINT refuse_expiry_audit");
  }
});

test("only service_role may execute the expiry RPC", async () => {
  for (const role of ["anon", "authenticated"]) {
    assert.equal(
      (
        await db.query(
          "SELECT has_function_privilege($1,'public.expire_omni_project_authorizations(uuid)','execute') AS allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
  }
  assert.equal(
    (
      await db.query(
        "SELECT has_function_privilege('service_role','public.expire_omni_project_authorizations(uuid)','execute') AS allowed",
      )
    ).rows[0].allowed,
    true,
  );
});

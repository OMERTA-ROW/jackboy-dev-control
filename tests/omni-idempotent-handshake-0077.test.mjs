// 0077 on top of the live link gate (0044 omni_link_action) in real PostgreSQL (PGlite).
// Proves: a repeated handshake with the same handshakeId reuses the open session,
// while the live session cap still refuses extra new sessions (legacy taps included).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({
  resolve(specifier, ctx, next) {
    if (specifier.startsWith("@/"))
      return next(pathToFileURL(resolve(root, "src", specifier.slice(2) + ".ts")).href, ctx);
    if (specifier.startsWith("./") && ctx.parentURL?.endsWith(".ts") && !specifier.endsWith(".ts"))
      return next(new URL(specifier + ".ts", ctx.parentURL).href, ctx);
    return next(specifier, ctx);
  },
});
const { handleOmniLink } = await import("../src/lib/omni-session.server.ts");
const { digest, requestMessage, LINK_PATH } = await import("../src/lib/omni-session.ts");
const { hmacHex } = await import("../src/lib/omni-link.ts");
const MIGRATION = process.env.OMNI_0077_SQL || join(root, "staging/applied-migrations-0075-0077/0077_omni_idempotent_handshake_forward.sql");
const db = new PGlite();
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE owner_projects(id uuid primary key,created_by uuid,active boolean);
CREATE TABLE user_roles(user_id uuid,role text);
CREATE TABLE automation_policy(id int primary key,paused boolean);
CREATE TABLE omni_callback_nonces(nonce text primary key,received_at timestamptz default now());
CREATE TABLE site_log(id uuid default gen_random_uuid(),actor text,action text,category text,status text,summary text,project_id uuid,detail jsonb);`);
await db.exec(await readFile(join(root, "drizzle/migrations/0044_omni_sessions.sql"), "utf8"));
const sql = await readFile(MIGRATION, "utf8");
await db.exec(sql);
await db.exec(sql); // re-running is a no-op: idempotent
const project = "11111111-1111-4111-8111-111111111111",
  owner = "22222222-2222-4222-8222-222222222222",
  approval = "33333333-3333-4333-8333-333333333333";
const config = {
  clientId: "omni-mothership", projectId: project, ownerId: owner, approvalId: approval,
  approvalExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  bootstrap: "b".repeat(64), secret: "s".repeat(64),
};
const store = async (op, args) =>
  (op === "handshake_idempotent"
    ? await db.query("SELECT omni_link_idempotent_handshake($1::jsonb) AS result", [JSON.stringify(args)])
    : await db.query("SELECT omni_link_action($1,$2::jsonb) AS result", [op, JSON.stringify(args)])).rows[0].result;
const sessions = async () => (await db.query("SELECT count(*)::int AS n FROM omni_link_sessions")).rows[0].n;
async function handshake(extra = {}) {
  const body = JSON.stringify({ action: "handshake", projectId: project, ...extra });
  const nonce = crypto.randomUUID().replaceAll("-", ""), ts = String(Math.floor(Date.now() / 1000));
  const signature = await hmacHex(config.secret, requestMessage(ts, nonce, await digest(config.bootstrap), body));
  const res = await handleOmniLink(new Request("https://jackboy.test" + LINK_PATH, {
    method: "POST", body,
    headers: { authorization: "Bearer " + config.bootstrap, "x-omni-client": config.clientId,
      "x-omni-nonce": nonce, "x-omni-timestamp": ts, "x-omni-signature": signature },
  }), config, store);
  return { status: res.status, ...(await res.json()) };
}
beforeEach(async () => {
  await db.exec("TRUNCATE omni_handshake_requests,omni_link_sessions,omni_inbound_jobs,omni_callback_nonces,site_log,owner_projects,user_roles,automation_policy;");
  await db.query("INSERT INTO owner_projects VALUES($1,$2,true)", [project, owner]);
  await db.query("INSERT INTO user_roles VALUES($1,'owner')", [owner]);
  await db.exec("INSERT INTO automation_policy VALUES(1,false)");
});
after(() => db.close());

test("repeat handshake with the same handshakeId reuses the one open session", async () => {
  const handshakeId = crypto.randomUUID();
  const first = await handshake({ handshakeId });
  assert.equal(first.status, 200);
  for (let i = 0; i < 12; i++) {
    const again = await handshake({ handshakeId });
    assert.equal(again.status, 200);
    assert.equal(again.sessionToken, first.sessionToken);
  }
  assert.equal(await sessions(), 1);
  const [row] = (await db.query("SELECT expires_at FROM omni_link_sessions")).rows;
  assert(row.expires_at.getTime() <= Date.now() + 5 * 60_000 + 1000, "5-minute lifetime unchanged");
});

test("the session cap still refuses extra new sessions, including manual taps", async () => {
  for (let i = 0; i < 7; i++) assert.equal((await handshake()).status, 200);
  const handshakeId = crypto.randomUUID();
  assert.equal((await handshake({ handshakeId })).status, 200); // 8th = live cap
  assert.equal((await handshake({ handshakeId })).status, 200); // retry reuses, no new slot
  assert.equal(await sessions(), 8);
  assert.equal((await handshake()).error, "session_limit"); // manual tap over the cap
  assert.equal((await handshake({ handshakeId: crypto.randomUUID() })).error, "session_limit");
  assert.equal(await sessions(), 8);
});

test("refusals still apply to repeats: Kill Switch on refuses the retry", async () => {
  const handshakeId = crypto.randomUUID();
  assert.equal((await handshake({ handshakeId })).status, 200);
  await db.exec("UPDATE automation_policy SET paused=true");
  assert.equal((await handshake({ handshakeId })).status, 403);
  assert.equal((await handshake()).status, 403);
});

test("retry table and function stay server-only", async () => {
  await db.exec("SET ROLE authenticated");
  try {
    await assert.rejects(db.query("SELECT omni_link_idempotent_handshake('{}')"));
    await assert.rejects(db.query("SELECT * FROM omni_handshake_requests"));
  } finally { await db.exec("RESET ROLE"); }
});

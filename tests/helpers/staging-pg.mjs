import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";

// Disposable-PostgreSQL helper. Only ever connects to a LOOPBACK server named by STAGING_PG_URL and
// creates/drops its own throwaway databases. Synthetic data only; no production credentials.
export const stagingUrl = process.env.STAGING_PG_URL;
export const skipNoPg = stagingUrl ? false : "STAGING_PG_URL not set (no disposable PostgreSQL)";

export async function waitForLock(db, pid, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await db.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [
      pid,
    ]);
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${pid} did not reach the expected lock wait`);
}

let pgModule;
let admin;

export async function openDb({ connections = 8 } = {}) {
  const url = new URL(stagingUrl);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("STAGING_PG_URL must be a loopback host; refusing to connect");
  }
  pgModule ??= createRequire(process.env.STAGING_PG_MODULE_FROM ?? import.meta.url)("pg");
  admin ??= new pgModule.Pool({ connectionString: stagingUrl, max: 2 });
  const name = `chain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const pool = new pgModule.Pool({ connectionString: url.toString(), max: connections });
  return {
    pool,
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    close: async () => {
      await pool.end();
      await dropClosedDatabase(admin, name);
    },
  };
}

export async function dropClosedDatabase(connection, name) {
  if (!/^(chain|spend|stg)_\d+_[a-z0-9]+$/.test(name)) {
    throw new Error("Refusing to drop a non-test database");
  }
  // Pool.end() can finish before the server has processed every socket's Terminate.
  // FORCE races those closing clients and can surface spurious FATAL errors in tests.
  const deadline = Date.now() + 5000;
  while (true) {
    const sessions = await connection.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",
      [name],
    );
    if (sessions.rows[0].n === 0) break;
    if (Date.now() >= deadline) throw new Error(`Test database ${name} still has open clients`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await connection.query(`DROP DATABASE ${name}`);
}

// Minimal stand-ins for the Supabase-managed objects the migrations reference.
export const supabaseStubs = `
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now());
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'anon' $$;
  CREATE SCHEMA extensions;
  CREATE SCHEMA storage;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
    SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean);
  CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`;

// Production applied the reviewed CODE safety files through the journaled migration tool, which
// saved byte-equivalent copies under later numbers (e.g. 0043_code_provider_gateway). Replay each
// migration name once, at its reviewed position, so the chain matches what actually ran.
export const migrationFiles = async () => {
  const seen = new Set();
  return (await readdir("drizzle/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => {
      const name = f.slice(5);
      if (name !== "migration.sql" && seen.has(name)) return false;
      seen.add(name);
      return true;
    });
};

// Applies each file in its own transaction so a failure names the file and leaves no partial state.
export async function replay(db, { through = "9999", from = "0000", skip = [] } = {}) {
  const applied = [];
  for (const file of await migrationFiles()) {
    const key = file.slice(0, 4);
    if (key < from || key > through || skip.includes(file)) continue;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(`drizzle/migrations/${file}`, "utf8"));
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      error.migration = file;
      throw error;
    } finally {
      client.release();
    }
  }
  return applied;
}

// Simulate an already-activated runtime in disposable databases without disabling the guard.
export async function setActivatedControls(db, sql, params = []) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jackboy.code_activation', 'owner-enabled', true)");
    await client.query(sql, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAdmin() {
  await admin?.end();
  admin = undefined;
}

import { pathToFileURL } from "node:url";
import postgres from "postgres";

export function connectionOptions(raw, expectedHost, expectedPort, expectedDatabase) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid staging database URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !expectedHost ||
    !/^[a-z0-9.-]+$/.test(expectedHost) ||
    !/^[0-9]{1,5}$/.test(expectedPort ?? "") ||
    Number(expectedPort) < 1 ||
    Number(expectedPort) > 65535 ||
    !/^[a-zA-Z0-9_-]+$/.test(expectedDatabase ?? "") ||
    url.hostname !== expectedHost ||
    url.port !== expectedPort ||
    url.pathname !== `/${expectedDatabase}` ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Staging database target or URL options do not match the expected target.");
  }
  return {
    host: expectedHost,
    port: Number(expectedPort),
    database: expectedDatabase,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true, servername: expectedHost },
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
  };
}

export async function inspectStaging(config, createClient = postgres) {
  const options = connectionOptions(config.url, config.host, config.port, config.database);
  const sql = createClient(options);
  try {
    return await sql.begin("read only", async (tx) => {
      const rows = await tx`
        SELECT current_database() AS database,
          to_regclass('public.code_runtime_controls') IS NOT NULL AS code_controls_present,
          EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' AND t.relname = 'code_runtime_controls'
              AND c.conname = 'code_runtime_controls_provider_hard_cap_verified_check'
          ) AS code_cap_constraint_present
      `;
      if (rows.length !== 1 || rows[0].database !== config.database) {
        throw new Error("Database identity did not match.");
      }
      return rows[0];
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await inspectStaging({
      url: process.env.STAGING_DATABASE_URL,
      host: process.env.STAGING_EXPECTED_HOST,
      port: process.env.STAGING_EXPECTED_PORT,
      database: process.env.STAGING_EXPECTED_DATABASE,
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error("Staging preflight failed. No database changes were attempted.");
    process.exitCode = 1;
  }
}

import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  connectionOptions,
  decodeCaCertificate,
  failureCategory,
} from "./staging-db-preflight.mjs";

export async function inspectPrerequisites(config, createClient = postgres) {
  const options = connectionOptions(
    config.url,
    "shinkansen.proxy.rlwy.net",
    "48734",
    "railway",
    config.ca,
  );
  const sql = createClient(options);
  try {
    return await sql.begin("read only", async (tx) => {
      const rows = await tx`
        SELECT current_database() = 'railway' AS database_matches,
          to_regnamespace('auth') IS NOT NULL AS auth_schema_exists,
          to_regnamespace('storage') IS NOT NULL AS storage_schema_exists,
          to_regclass('auth.users') IS NOT NULL AS auth_users_exists,
          to_regprocedure('auth.uid()') IS NOT NULL AS auth_uid_exists,
          to_regclass('storage.objects') IS NOT NULL AS storage_objects_exists,
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS anon_role_exists,
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS authenticated_role_exists,
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') AS service_role_exists,
          to_regnamespace('drizzle') IS NOT NULL AS drizzle_schema_exists,
          to_regclass('public.code_runtime_controls') IS NOT NULL AS code_controls_exist
      `;
      if (rows.length !== 1 || !rows[0].database_matches) throw new Error("database_mismatch");
      return rows[0];
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await inspectPrerequisites({
      url: process.env.STAGING_DATABASE_URL,
      ca: decodeCaCertificate(process.env.STAGING_DB_CA_CERT),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      `Staging diagnostics failed (${failureCategory(error)}). No writes were attempted.`,
    );
    process.exitCode = 1;
  }
}

import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  connectionOptions,
  decodeCaCertificate,
  failureCategory,
} from "./staging-db-preflight.mjs";

export async function inspectEnvironment(config, createClient = postgres) {
  const options = connectionOptions(
    config.url,
    "shinkansen.proxy.rlwy.net",
    "48734",
    "railway",
    config.ca,
  );
  const sql = createClient(options);
  try {
    return await sql.begin("isolation level repeatable read read only", async (tx) => {
      const rows = await tx`
        SELECT current_database() = 'railway' AS database_matches,
          to_regclass('public.jackboy_staging_identity') IS NOT NULL AS marker_present,
          to_regclass('public.code_runtime_controls') IS NOT NULL AS controls_present,
          to_regnamespace('auth') IS NOT NULL AS auth_schema_present,
          to_regnamespace('storage') IS NOT NULL AS storage_schema_present,
          to_regnamespace('drizzle') IS NOT NULL AS drizzle_schema_present,
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS anon_role_present,
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS authenticated_role_present,
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') AS service_role_present
      `;
      if (rows.length !== 1 || !rows[0].database_matches) throw new Error("database_mismatch");
      let marker = "absent";
      if (rows[0].marker_present) {
        const result = await tx`
          SELECT count(*) = 1 AND count(*) FILTER (
            WHERE environment_id = '83515d1e-141f-4fd1-8dfb-50764a73a5db'::uuid
              AND service_id = 'f0c879d1-1934-4b5b-b4e6-728bc807d51d'::uuid
          ) = 1 AS matches
          FROM public.jackboy_staging_identity
        `;
        if (result.length !== 1) throw new Error("marker_query_failed");
        marker = result[0].matches ? "matching" : "conflicting";
      }
      return { ...rows[0], marker };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await inspectEnvironment({
      url: process.env.STAGING_DATABASE_URL,
      ca: decodeCaCertificate(process.env.STAGING_DB_CA_CERT),
    });
    console.log(JSON.stringify(result));
    if (result.marker === "conflicting") process.exitCode = 1;
  } catch (error) {
    console.error(
      `Staging environment preflight failed (${failureCategory(error)}). No writes were attempted.`,
    );
    process.exitCode = 1;
  }
}

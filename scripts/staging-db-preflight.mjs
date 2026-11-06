import { pathToFileURL } from "node:url";
import postgres from "postgres";

class PreflightError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

export function failureCategory(error) {
  if (error instanceof PreflightError) return error.category;
  const code = error?.code;
  if (
    [
      "CERT_HAS_EXPIRED",
      "CERT_NOT_YET_VALID",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(code)
  ) {
    return "tls_certificate";
  }
  if (code === "28000" || code === "28P01") return "authentication";
  if (
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ECONNRESET",
      "CONNECT_TIMEOUT",
    ].includes(code)
  ) {
    return "connection";
  }
  return "unclassified";
}

export function connectionOptions(raw, expectedHost, expectedPort, expectedDatabase) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PreflightError("invalid_url");
  }
  if (
    !expectedHost ||
    !/^[a-z0-9.-]+$/.test(expectedHost) ||
    !/^[0-9]{1,5}$/.test(expectedPort ?? "") ||
    Number(expectedPort) < 1 ||
    Number(expectedPort) > 65535 ||
    !/^[a-zA-Z0-9_-]+$/.test(expectedDatabase ?? "")
  ) {
    throw new PreflightError("invalid_expected_target");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash
  ) {
    throw new PreflightError("invalid_url_options");
  }
  if (
    url.hostname !== expectedHost ||
    url.port !== expectedPort ||
    url.pathname !== `/${expectedDatabase}`
  ) {
    throw new PreflightError("target_mismatch");
  }
  let username, password;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new PreflightError("invalid_url");
  }
  return {
    host: expectedHost,
    port: Number(expectedPort),
    database: expectedDatabase,
    username,
    password,
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
        throw new PreflightError("database_mismatch");
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
  } catch (error) {
    console.error(
      `Staging preflight failed (${failureCategory(error)}). No database changes were attempted.`,
    );
    process.exitCode = 1;
  }
}

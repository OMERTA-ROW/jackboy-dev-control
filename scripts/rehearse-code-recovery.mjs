import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const source = "supabase_db_jackboy-recovery-test";
const database = "jackboy_backup_restore";
const targetDatabase = "code_rehearsal";
const label = "jackboy.rehearsal=0060";
const sqlHash = (sql) => createHash("sha256").update(sql).digest("hex");

export function verifyIsolation(info) {
  if (
    info.HostConfig.NetworkMode !== "none" ||
    !info.HostConfig.ReadonlyRootfs ||
    Object.keys(info.HostConfig.PortBindings ?? {}).length ||
    info.HostConfig.Binds?.length ||
    info.Mounts.some((mount) => mount.Type !== "tmpfs") ||
    info.Config.Labels?.["jackboy.rehearsal"] !== "0060"
  ) {
    throw new Error("Disposable container isolation verification failed");
  }
}

function command(args, input) {
  const result = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Dump/SQL errors can contain private restored row data; never echo their bodies.
    const state = result.stderr?.match(/ERROR:\s+([0-9A-Z]{5})\b/)?.[1];
    throw new Error(
      `Docker operation failed: ${args[0]} ${args[1] ?? ""}${state ? ` SQLSTATE ${state}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function query(container, db, sql, readOnly = false) {
  return command(
    [
      "exec",
      "-i",
      "-u",
      "postgres",
      container,
      "psql",
      "-X",
      "-h",
      container === source ? "/var/run/postgresql" : "/tmp",
      "-U",
      container === source ? "supabase_admin" : "rehearsal_admin",
      "-d",
      db,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=sqlstate",
      "-Atq",
    ],
    readOnly ? `BEGIN READ ONLY;\n${sql}\nCOMMIT;` : sql,
  );
}

const fingerprint = `
  SELECT md5(jsonb_build_object(
    'controls',(SELECT jsonb_agg(to_jsonb(c)) FROM public.code_runtime_controls c),
    'journal',(SELECT jsonb_agg(to_jsonb(j) ORDER BY created_at,id) FROM drizzle.__drizzle_migrations j),
    'audit_rows',(SELECT count(*) FROM public.audit_logs),
    'reservations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM public.code_spend_reservations r),
    'omni',(SELECT jsonb_agg(to_jsonb(o) ORDER BY to_jsonb(o)::text) FROM public.omni_connection o),
    'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,
      p.proacl::text,pg_get_functiondef(p.oid)) ORDER BY p.oid)
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f')
    ,'triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid)) ORDER BY tgname)
      FROM pg_trigger WHERE tgrelid='public.code_spend_reservations'::regclass)
  )::text);`;

const vaultManifest = `
  SELECT coalesce(jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),
    pg_get_userbyid(p.proowner),p.proacl::text) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)),
    '[]'::jsonb)::text
  FROM pg_proc p WHERE p.pronamespace='vault'::regnamespace;`;

const permissionManifest = `
  SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid),pg_get_userbyid(p.proowner),p.proacl::text,p.prosecdef)
      ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','vault','auth')),
    'tables',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,pg_get_userbyid(c.relowner),
      c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','vault','auth','drizzle') AND c.relkind IN ('r','p','v','S')),
    'roles',(SELECT jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,
      rolcreatedb,rolreplication,rolbypassrls) ORDER BY rolname)
      FROM pg_roles WHERE rolname !~ '^pg_' AND rolname<>'rehearsal_admin'),
    'membership',(SELECT jsonb_agg(jsonb_build_array(r.rolname,m.rolname,
      a.admin_option,a.inherit_option,a.set_option) ORDER BY r.rolname,m.rolname)
      FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member)
  )::text;`;

async function copyDatabase(target) {
  const dump = spawn(
    "docker",
    [
      "exec",
      "-u",
      "postgres",
      source,
      "pg_dump",
      "-U",
      "supabase_admin",
      "-Fc",
      "--exclude-table-data=vault.secrets",
      "-d",
      database,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const restore = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "postgres",
      target,
      "pg_restore",
      "-h",
      "/tmp",
      "-U",
      "rehearsal_admin",
      "--role=supabase_admin",
      "--exit-on-error",
      "-d",
      targetDatabase,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const categories = new Set();
  let diagnostic = "";
  for (const child of [dump, restore]) {
    child.stderr.on("data", (chunk) => {
      if (!diagnostic)
        diagnostic = chunk
          .toString()
          .split("\n")[0]
          .replace(/"[^"]*"|'[^']*'/g, "<redacted>")
          .slice(0, 200);
      for (const category of [
        "permission denied",
        "grant options cannot",
        "already exists",
        "does not exist",
        "must be owner",
        "extension",
        "could not access file",
        "cannot execute",
        "out of memory",
      ])
        if (chunk.toString().includes(category)) categories.add(category);
    });
  }
  restore.once("close", (code) => {
    if (code !== 0) dump.kill("SIGTERM");
  });
  dump.stdout.pipe(restore.stdin);
  restore.stdin.on("error", () => {}); // Exit statuses below report a closed restore pipe.
  const wait = (child) =>
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  const timer = setTimeout(() => {
    dump.kill("SIGTERM");
    restore.kill("SIGTERM");
  }, 120_000);
  try {
    const results = await Promise.all([wait(dump), wait(restore)]);
    if (results.some((code) => code !== 0))
      throw new Error(
        `Ownership-preserving restore failed (dump=${results[0]}, restore=${results[1]}; ${diagnostic || [...categories].join(", ") || "timeout or transport"})`,
      );
  } finally {
    clearTimeout(timer);
  }
}

export async function rehearse() {
  if (process.argv.length !== 2)
    throw new Error("This harness accepts no alternate resource targets");
  const context = JSON.parse(command(["context", "inspect"]))[0];
  if (!context.Endpoints.docker.Host.startsWith("unix://") || process.env.DOCKER_HOST) {
    throw new Error("A local Unix-socket Docker context without DOCKER_HOST is required");
  }
  const info = JSON.parse(command(["inspect", source]))[0];
  if (!info.Config.Image.startsWith("public.ecr.aws/supabase/postgres:17.11.")) {
    throw new Error("Source must use the reviewed Supabase PostgreSQL 17.11 image");
  }
  const version = query(source, database, "SHOW server_version;", true);
  if (version !== "17.11")
    throw new Error("Source must be the reviewed local PostgreSQL 17.11 restore");
  const image = info.Image;
  const target = `jackboy-0060-rehearsal-${randomUUID()}`;
  const before = query(source, database, fingerprint, true);
  const roles = query(
    source,
    database,
    `
    SELECT format('CREATE ROLE %I NOLOGIN %s %s %s %s %s %s;',rolname,
      CASE WHEN rolsuper THEN 'SUPERUSER' ELSE 'NOSUPERUSER' END,
      CASE WHEN rolinherit THEN 'INHERIT' ELSE 'NOINHERIT' END,
      CASE WHEN rolcreaterole THEN 'CREATEROLE' ELSE 'NOCREATEROLE' END,
      CASE WHEN rolcreatedb THEN 'CREATEDB' ELSE 'NOCREATEDB' END,
      CASE WHEN rolreplication THEN 'REPLICATION' ELSE 'NOREPLICATION' END,
      CASE WHEN rolbypassrls THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END)
      FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname;
    SELECT format('GRANT %I TO %I WITH ADMIN %s, INHERIT %s, SET %s;',r.rolname,m.rolname,
      a.admin_option::text,a.inherit_option::text,a.set_option::text)
      FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
      ORDER BY r.rolname,m.rolname;`,
    true,
  );
  const journal = JSON.parse(await readFile("drizzle/migrations/meta/_journal.json", "utf8"));
  const migrations = await Promise.all(
    [58, 59, 60].map(async (idx) => {
      const entry = journal.entries.find((item) => item.idx === idx);
      const sql = await readFile(`drizzle/migrations/${entry.tag}.sql`, "utf8");
      return { ...entry, sql, hash: sqlHash(sql) };
    }),
  );
  const anchor = migrations[0];
  const baseline = query(
    source,
    database,
    `
    SELECT (count(*)=1)::text FROM drizzle.__drizzle_migrations
      WHERE created_at=${anchor.when} AND hash='${anchor.hash}';
    SELECT (max(created_at)=${anchor.when})::text FROM drizzle.__drizzle_migrations;
    SELECT ((SELECT count(*) FROM pg_subscription WHERE subdbid=(SELECT oid FROM pg_database
      WHERE datname=current_database()))=0 AND (SELECT count(*) FROM pg_foreign_server)=0)::text;`,
    true,
  );
  if (baseline !== "true\ntrue\ntrue")
    throw new Error("Restore baseline/subscription identity mismatch");
  console.log(`SOURCE PostgreSQL ${version}; 0058 journal anchor verified; image ${image}`);
  let created = false;
  try {
    command([
      "run",
      "--detach",
      "--name",
      target,
      "--label",
      label,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,mode=1777",
      "--user",
      "postgres",
      "--entrypoint",
      "sh",
      image,
      "-c",
      "initdb -D /tmp/pg -U rehearsal_admin --auth=trust >/tmp/init.log && exec postgres -D /tmp/pg -c listen_addresses= -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_net -c max_worker_processes=0 -c max_wal_senders=0",
    ]);
    created = true;
    verifyIsolation(JSON.parse(command(["inspect", target]))[0]);
    let listening = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const probe = spawnSync(
        "docker",
        [
          "exec",
          "-u",
          "postgres",
          target,
          "pg_isready",
          "-h",
          "/tmp",
          "-U",
          "rehearsal_admin",
          "-d",
          "postgres",
        ],
        { timeout: 5000, stdio: "ignore" },
      );
      if (probe.status === 0) {
        listening = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!listening) throw new Error("Disposable server failed readiness");
    console.log("PASS network-none PostgreSQL 17.11 ready; reconstructing local ownership roles");
    query(target, "postgres", `${roles}\nCREATE DATABASE ${targetDatabase} OWNER postgres;`);
    // Managed event triggers are owned by postgres even though Supabase later removes its
    // superuser flag. PostgreSQL requires that flag while assigning event-trigger ownership.
    // This temporary role change exists only in the network-none, NOLOGIN disposable cluster.
    query(target, "postgres", "ALTER ROLE postgres SUPERUSER;");
    await copyDatabase(target);
    query(target, "postgres", "ALTER ROLE postgres NOSUPERUSER;");
    if (
      query(source, database, vaultManifest, true) !==
        query(target, targetDatabase, vaultManifest) ||
      query(source, database, permissionManifest, true) !==
        query(target, targetDatabase, permissionManifest)
    ) {
      throw new Error("Restored ownership/ACL/role fidelity mismatch");
    }
    const isolatedState = query(
      target,
      targetDatabase,
      `
      SELECT (current_setting('max_worker_processes')='0'
        AND current_setting('max_wal_senders')='0'
        AND current_setting('listen_addresses')=''
        AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE backend_type LIKE '%worker%')
        AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname !~ '^pg_' AND rolname<>'rehearsal_admin' AND rolcanlogin)
        AND (SELECT count(*) FROM vault.secrets)=0)::text;`,
    );
    if (isolatedState !== "true")
      throw new Error("External worker/login/secret isolation mismatch");
    console.log(
      "PASS ownership/ACL-preserving restore; Vault secret data excluded; all source roles NOLOGIN",
    );
    query(
      target,
      targetDatabase,
      `
      BEGIN;
      DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM public.code_spend_reservations)
          OR EXISTS(SELECT 1 FROM public.code_runtime_controls
            WHERE active_request_id IS NOT NULL OR active_run_id IS NOT NULL)
        THEN RAISE EXCEPTION 'Active work requires separate accounting review'; END IF;
      END $$;
      UPDATE public.code_runtime_controls SET enabled=false,kill_switch=true,provider_usage_at=NULL;
      UPDATE public.automation_policy SET paused=true;
      COMMIT;`,
    );
    console.log(
      "PASS disposable CODE disabled, Emergency Stop/global pause engaged; no active work; no network/workers",
    );
    for (const migration of migrations.slice(1)) {
      const record = `INSERT INTO drizzle.__drizzle_migrations(hash,created_at)
        VALUES ('${migration.hash}',${migration.when});`;
      const snapshot = query(target, targetDatabase, fingerprint);
      let failed = false;
      try {
        query(
          target,
          targetDatabase,
          `BEGIN;\nSET LOCAL ROLE postgres;\n${migration.sql}\n${record}
          DO $$ BEGIN RAISE EXCEPTION 'intentional rehearsal failure'; END $$;\nCOMMIT;`,
        );
      } catch (error) {
        if (!error.message.includes("SQLSTATE P0001")) throw error;
        failed = true;
      }
      if (!failed || query(target, targetDatabase, fingerprint) !== snapshot) {
        throw new Error(`${migration.tag}: failed transaction did not roll back`);
      }
      query(
        target,
        targetDatabase,
        `BEGIN;\nSET LOCAL ROLE postgres;\n${migration.sql}\n${record}\nCOMMIT;`,
      );
      console.log(
        `PASS ${migration.tag}: late failure rollback and transactional install; hash ${migration.hash}`,
      );
    }
    const installed = query(
      target,
      targetDatabase,
      `
      SELECT (count(*)=2 AND count(DISTINCT hash)=2)::text
      FROM drizzle.__drizzle_migrations WHERE
        (hash='${migrations[1].hash}' AND created_at=${migrations[1].when})
        OR (hash='${migrations[2].hash}' AND created_at=${migrations[2].when});`,
    );
    if (installed !== "true") throw new Error("Installed migration history mismatch");
    query(
      target,
      targetDatabase,
      await readFile("tests/fixtures/code-recovery-verification.sql", "utf8"),
    );
    console.log(
      "PASS trigger identity, role grants, stopped admission, acceptance hold, cumulative cap and daily ceiling assertions",
    );
    const rows = query(
      target,
      targetDatabase,
      `
      SELECT jsonb_build_object('enabled',enabled,'kill_switch',kill_switch,
        'daily',daily_spend_limit_usd,'total',total_spend_limit_usd,
        'active_request',active_request_id IS NOT NULL,'active_run',active_run_id IS NOT NULL)
        FROM public.code_runtime_controls;
      SELECT hash||':'||created_at FROM drizzle.__drizzle_migrations
        WHERE created_at>=${migrations[1].when} ORDER BY created_at;`,
    );
    console.log(rows);
  } finally {
    if (created) command(["rm", "--force", target]);
    if (query(source, database, fingerprint, true) !== before) {
      throw new Error(
        "Source recovery database changed during rehearsal; investigate concurrent activity",
      );
    }
    console.log("PASS original recovery fingerprint unchanged; disposable container removed");
  }
  console.log(
    "BLOCKED full recovery: cron, excluded Realtime functions, Vault secret recovery and provider backup/PITR remain unverified",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rehearse().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

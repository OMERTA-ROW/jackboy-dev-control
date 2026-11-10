import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const original = await readFile(
  new URL("../drizzle/migrations/0062_omni_dispatch_v3.sql", import.meta.url),
  "utf8",
);
const wrapper = await readFile(
  new URL("../scripts/reconcile-omni-dispatch-v3.psql", import.meta.url),
  "utf8",
);
const include = "\\ir ../drizzle/migrations/0062_omni_dispatch_v3.sql";
// Model psql's single relative include in an in-memory PostgreSQL engine only.
const sql = wrapper.replace("\\set ON_ERROR_STOP on\n", "").replace(include, () => original);
const suffix = "_legacy_lovable";
const names = ["omni_dispatch_v3_record", "omni_dispatch_v3_callback_scope"];
const historical = await readFile(
  new URL("./fixtures/omni-dispatch-v3-legacy-lovable.sql", import.meta.url),
  "utf8",
);

const setup = await readFile(
  new URL("./fixtures/omni-dispatch-v3-prerequisites.sql", import.meta.url),
  "utf8",
);

const withDb = async (fn) => {
  const db = new PGlite();
  try {
    await db.exec(setup);
    await db.exec(historical);
    await fn(db);
  } finally {
    await db.close();
  }
};
const query = async (db, text) => (await db.query(text)).rows;
const fingerprint = (db) =>
  query(
    db,
    `
  SELECT 'relation' AS kind, c.oid, c.relname AS name,
    jsonb_build_object('kind', c.relkind, 'rls', c.relrowsecurity, 'acl', c.relacl) AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'function', p.oid, p.proname,
    jsonb_build_object('definition', pg_get_functiondef(p.oid), 'acl', p.proacl)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'constraint', c.oid, c.conname, to_jsonb(pg_get_constraintdef(c.oid))
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'policy', p.oid, p.polname, to_jsonb(p)
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  ORDER BY kind, oid
`,
  );
const columns = (db, name) =>
  query(
    db,
    `
  SELECT attname FROM pg_attribute WHERE attrelid = 'public.${name}'::regclass
    AND attnum > 0 AND NOT attisdropped ORDER BY attnum
`,
  );

test("operator wrapper includes exactly the immutable main 0062 bytes, outside the journal", async () => {
  assert.equal(
    createHash("sha256").update(historical).digest("hex"),
    "d62525c64fc499d77d1dca6f8b44c5e0c25bfbdf210b643936e38af7624b2ec4",
  );
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "3d9e882b8cec18835456220c126d08d489037a61a5cc5bdf1b218bc06af3a3bf",
  );
  assert.equal(wrapper.split(include).length, 2);
  assert.deepEqual(
    wrapper.split("\n").filter((line) => line.startsWith("\\")),
    ["\\set ON_ERROR_STOP on", include],
  );
  assert.match(sql, /BEGIN;[\s\S]*LOCK TABLE ONLY[\s\S]*ACCESS EXCLUSIVE MODE/);
  assert.ok(
    sql.indexOf("ACCESS EXCLUSIVE MODE") <
      sql.indexOf("IF EXISTS (SELECT 1 FROM public.omni_dispatch_v3_jobs)"),
  );
  assert.ok(
    sql.indexOf(original) > sql.indexOf("ALTER TABLE public.omni_dispatch_v3_jobs RENAME TO"),
  );
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(wrapper, /\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT)\b/i);
  const journal = JSON.parse(
    await readFile(new URL("../drizzle/migrations/meta/_journal.json", import.meta.url), "utf8"),
  );
  assert.equal(journal.entries.at(-1).tag, "0062_omni_dispatch_v3");
  assert.equal(journal.entries.at(-1).when, 1794285308000);
});

test("empty legacy objects retain OIDs, definitions, grants, constraints and RLS; exact 0062 is installed", async () => {
  await withDb(async (db) => {
    const before = await fingerprint(db);
    const oldColumns = await columns(db, "omni_dispatch_v3_jobs");
    await db.exec(sql);
    const after = await fingerprint(db);
    for (const prior of before) {
      const current = after.find((row) => row.kind === prior.kind && row.oid === prior.oid);
      assert.ok(current, `lost object ${prior.name}`);
      if (
        prior.name === "omni_dispatch_v3_jobs" ||
        names.includes(prior.name) ||
        ["omni_dispatch_v3_jobs_pkey", "omni_dispatch_v3_jobs_grant_id_job_id_key"].includes(
          prior.name,
        )
      ) {
        assert.equal(current.name, prior.name + suffix);
      } else {
        assert.equal(current.name, prior.name);
      }
      if (prior.kind === "function" && names.includes(prior.name)) {
        assert.deepEqual(current.detail, {
          ...prior.detail,
          definition: prior.detail.definition.replace(
            `public.${prior.name}(`,
            `public.${prior.name}${suffix}(`,
          ),
        });
      } else {
        assert.deepEqual(current.detail, prior.detail);
      }
    }
    assert.deepEqual(await columns(db, "omni_dispatch_v3_jobs" + suffix), oldColumns);
    assert.deepEqual(
      (await columns(db, "omni_dispatch_v3_jobs")).map((r) => r.attname),
      [
        "job_id",
        "grant_id",
        "owner_id",
        "project_id",
        "repo",
        "kind",
        "payload_digest",
        "expires_at",
        "status",
        "result",
        "created_at",
        "updated_at",
      ],
    );
    assert.equal(
      (
        await query(
          db,
          `
      SELECT count(*)::int AS n FROM pg_class
      WHERE oid IN ('public.omni_dispatch_v3_jobs'::regclass,
        'public.omni_dispatch_v3_callback_events'::regclass,
        'public.omni_dispatch_v3_callback_nonces'::regclass) AND relrowsecurity
    `,
        )
      )[0].n,
      3,
    );
    assert.equal(
      (
        await query(
          db,
          `
      SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('guard_omni_dispatch_v3_scope',
        'omni_dispatch_v3_action', 'omni_dispatch_v3_pending_cancellations',
        'omni_dispatch_v3_callback_record')
    `,
        )
      )[0].n,
      4,
    );
    assert.equal(
      (
        await query(
          db,
          `
      SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgrelid = 'public.omni_dispatch_v3_jobs'::regclass AND tgname = 'omni_dispatch_v3_scope_immutable'
    `,
        )
      )[0].n,
      1,
    );
    assert.deepEqual(
      (
        await query(
          db,
          `
      SELECT has_table_privilege('authenticated','public.omni_dispatch_v3_jobs','SELECT') AS client,
        has_table_privilege('service_role','public.omni_dispatch_v3_jobs','INSERT') AS service,
        pg_get_serial_sequence('public.omni_dispatch_v3_callback_events','id')
          = 'public.omni_dispatch_v3_callback_events_id_seq' AS sequence
    `,
        )
      )[0],
      { client: false, service: true, sequence: true },
    );
  });
});

const cases = [
  [
    "nonempty",
    `
    INSERT INTO public.omni_jobs VALUES ('11111111-1111-4111-8111-111111111111');
    INSERT INTO public.omni_dispatch_grants(id) VALUES ('22222222-2222-4222-8222-222222222222');
    INSERT INTO public.agent_projects VALUES ('33333333-3333-4333-8333-333333333333');
    INSERT INTO public.omni_dispatch_v3_jobs(job_id,grant_id,owner_id,project_id,repo,status,last_source)
      VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        '44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','acme/repo','approved','dispatch');
  `,
    /not empty/,
  ],
  [
    "table suffix collision",
    "CREATE TABLE public.omni_dispatch_v3_jobs_legacy_lovable(id int)",
    /suffix collision/,
  ],
  [
    "type suffix collision",
    "CREATE TYPE public.omni_dispatch_v3_jobs_legacy_lovable AS (id int)",
    /suffix collision/,
  ],
  [
    "function suffix collision",
    "CREATE FUNCTION public.omni_dispatch_v3_record_legacy_lovable() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
    /suffix collision/,
  ],
  [
    "index suffix collision",
    "CREATE INDEX omni_dispatch_v3_jobs_pkey_legacy_lovable ON public.omni_dispatch_v3_jobs(status)",
    /suffix collision/,
  ],
  [
    "constraint suffix collision",
    "ALTER TABLE public.omni_dispatch_v3_jobs ADD CONSTRAINT omni_dispatch_v3_jobs_pkey_legacy_lovable CHECK (true)",
    /suffix collision/,
  ],
  [
    "callback function suffix collision",
    "CREATE FUNCTION public.omni_dispatch_v3_callback_scope_legacy_lovable() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
    /suffix collision/,
  ],
  [
    "missing record",
    "DROP FUNCTION public.omni_dispatch_v3_record(text,text,uuid,uuid,uuid,uuid,text,text,jsonb)",
    /Missing or ambiguous/,
  ],
  [
    "missing callback",
    "DROP FUNCTION public.omni_dispatch_v3_callback_scope(uuid,uuid,uuid)",
    /Missing or ambiguous/,
  ],
  [
    "ambiguous overload",
    "CREATE FUNCTION public.omni_dispatch_v3_record(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
    /Missing or ambiguous/,
  ],
  [
    "procedure instead of function",
    "DROP FUNCTION public.omni_dispatch_v3_record(text,text,uuid,uuid,uuid,uuid,text,text,jsonb); CREATE PROCEDURE public.omni_dispatch_v3_record() LANGUAGE plpgsql AS $$ BEGIN NULL; END $$",
    /Incompatible legacy function/,
  ],
  [
    "incompatible signature",
    "DROP FUNCTION public.omni_dispatch_v3_callback_scope(uuid,uuid,uuid); CREATE FUNCTION public.omni_dispatch_v3_callback_scope(text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$",
    /Incompatible legacy function/,
  ],
  [
    "incompatible return type",
    "DROP FUNCTION public.omni_dispatch_v3_callback_scope(uuid,uuid,uuid); CREATE FUNCTION public.omni_dispatch_v3_callback_scope(uuid,uuid,uuid) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
    /Incompatible legacy function/,
  ],
  ["missing table", "DROP TABLE public.omni_dispatch_v3_jobs", /requires the ordinary legacy/],
  [
    "wrong shape",
    "ALTER TABLE public.omni_dispatch_v3_jobs ADD COLUMN kind text",
    /Unsupported legacy table columns/,
  ],
  [
    "wrong type",
    "ALTER TABLE public.omni_dispatch_v3_jobs ALTER COLUMN result TYPE text USING result::text",
    /Unsupported legacy column types/,
  ],
  [
    "missing primary key",
    "ALTER TABLE public.omni_dispatch_v3_jobs DROP CONSTRAINT omni_dispatch_v3_jobs_pkey",
    /Unsupported legacy primary key/,
  ],
  [
    "incoming FK",
    "CREATE TABLE public.incoming(job uuid REFERENCES public.omni_dispatch_v3_jobs(job_id))",
    /Unsupported legacy trigger/,
  ],
  [
    "dependent view",
    "CREATE VIEW public.legacy_view AS SELECT * FROM public.omni_dispatch_v3_jobs",
    /Unsupported legacy trigger/,
  ],
  [
    "dependent row-type function",
    "CREATE FUNCTION public.old_reader() RETURNS SETOF public.omni_dispatch_v3_jobs LANGUAGE sql AS $$ SELECT * FROM public.omni_dispatch_v3_jobs $$",
    /dependent function/,
  ],
  [
    "owned sequence",
    "CREATE SEQUENCE public.old_sequence OWNED BY public.omni_dispatch_v3_jobs.last_source",
    /owned sequence/,
  ],
  [
    "legacy trigger",
    `
    CREATE FUNCTION public.old_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER legacy_trigger BEFORE UPDATE ON public.omni_dispatch_v3_jobs FOR EACH ROW EXECUTE FUNCTION public.old_trigger();
  `,
    /Unsupported legacy trigger/,
  ],
  ["missing prerequisite", "DROP FUNCTION public.omni_link_live()", /prerequisite functions/],
  [
    "missing prerequisite columns",
    "ALTER TABLE public.omni_dispatch_grants DROP COLUMN authorization_id",
    /prerequisite columns/,
  ],
  [
    "incompatible prerequisite columns",
    "ALTER TABLE public.omni_dispatch_grants ALTER COLUMN kind TYPE int USING NULL::int",
    /prerequisite columns/,
  ],
  [
    "preexisting callback sequence",
    "CREATE SEQUENCE public.omni_dispatch_v3_callback_events_id_seq",
    /relation name collision/,
  ],
  [
    "preexisting callback index",
    "CREATE INDEX omni_dispatch_v3_callback_events_pkey ON public.omni_dispatch_v3_jobs(status)",
    /relation name collision/,
  ],
  [
    "preexisting callback type",
    "CREATE TYPE public.omni_dispatch_v3_callback_events AS (id int)",
    /(?:relation|type) name collision/,
  ],
  // Failure deep inside unchanged 0062, after the legacy renames and all new tables.
  [
    "late 0062 failure",
    "CREATE FUNCTION public.guard_omni_dispatch_v3_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    /already exists/,
  ],
];

for (const [label, change, error] of cases) {
  test(`${label} aborts atomically without changing any existing object`, async () => {
    await withDb(async (db) => {
      await db.exec(change);
      const before = await fingerprint(db);
      await assert.rejects(db.exec(sql), error);
      await db.exec("ROLLBACK");
      assert.deepEqual(await fingerprint(db), before);
      if (label === "nonempty") {
        assert.equal(
          (await query(db, "SELECT count(*)::int AS n FROM public.omni_dispatch_v3_jobs"))[0].n,
          1,
        );
      }
    });
  });
}

test("legacy unique constraints and standalone colliding indexes are preserved with suffixed names", async () => {
  await withDb(async (db) => {
    await db.exec(`
      ALTER TABLE public.omni_dispatch_v3_jobs ADD UNIQUE(grant_id,job_id);
      ALTER TABLE public.omni_dispatch_v3_jobs RENAME CONSTRAINT omni_dispatch_v3_jobs_pkey TO historical_pk;
      CREATE UNIQUE INDEX omni_dispatch_v3_jobs_pkey ON public.omni_dispatch_v3_jobs(job_id);
    `);
    const before = await query(
      db,
      `
      SELECT indexrelid::int AS oid FROM pg_index WHERE indrelid = 'public.omni_dispatch_v3_jobs'::regclass
      ORDER BY indexrelid
    `,
    );
    await db.exec(sql);
    const after = await query(
      db,
      `
      SELECT indexrelid::int AS oid FROM pg_index WHERE indrelid = 'public.omni_dispatch_v3_jobs_legacy_lovable'::regclass
      ORDER BY indexrelid
    `,
    );
    assert.deepEqual(after, before);
    assert.equal(
      (
        await query(
          db,
          `
      SELECT count(*)::int AS n FROM pg_class WHERE relname IN
        ('omni_dispatch_v3_jobs_pkey_legacy_lovable', 'omni_dispatch_v3_jobs_grant_id_job_id_key_legacy_lovable')
    `,
        )
      )[0].n,
      2,
    );
  });
});

test("RLS cannot hide old rows from an unprivileged operator", async () => {
  await withDb(async (db) => {
    await db.exec(`
      GRANT USAGE ON SCHEMA public TO authenticated;
      ALTER TABLE public.omni_dispatch_v3_jobs OWNER TO authenticated;
      ALTER TABLE public.omni_dispatch_v3_jobs FORCE ROW LEVEL SECURITY;
    `);
    const before = await fingerprint(db);
    await db.exec("SET ROLE authenticated");
    await assert.rejects(db.exec(sql), /operator that bypasses RLS/);
    await db.exec("ROLLBACK; RESET ROLE");
    assert.deepEqual(await fingerprint(db), before);
  });
});

test("an index not owned by the legacy table is never renamed", async () => {
  await withDb(async (db) => {
    await db.exec(`
      ALTER TABLE public.omni_dispatch_v3_jobs RENAME CONSTRAINT omni_dispatch_v3_jobs_pkey TO old_pk;
      CREATE TABLE public.unrelated(id int);
      CREATE INDEX omni_dispatch_v3_jobs_pkey ON public.unrelated(id);
    `);
    const before = await fingerprint(db);
    await assert.rejects(db.exec(sql), /unrelated object/);
    await db.exec("ROLLBACK");
    assert.deepEqual(await fingerprint(db), before);
  });
});

test("successful reconciliation is not rerunnable over the new schema", async () => {
  await withDb(async (db) => {
    await db.exec(sql);
    const before = await fingerprint(db);
    await assert.rejects(db.exec(sql), /Unsupported legacy table columns/);
    await db.exec("ROLLBACK");
    assert.deepEqual(await fingerprint(db), before);
  });
});

test("generated v3 types match the reconciled catalog, including legacy names and FK identities", async () => {
  const source = ts.createSourceFile(
    "types.ts",
    await readFile(new URL("../src/integrations/supabase/types.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const member = (node, name) => {
    assert.ok(ts.isTypeLiteralNode(node), `expected type literal for ${name}`);
    const result = node.members.find((m) => m.name?.getText(source) === name);
    assert.ok(result, `missing generated ${name}`);
    return result.type;
  };
  const database = source.statements.find(
    (s) => ts.isTypeAliasDeclaration(s) && s.name.text === "Database",
  );
  const schema = member(database.type, "public");
  const tables = member(schema, "Tables");
  const functions = member(schema, "Functions");
  const v3Names = (node) =>
    node.members
      .map((m) => m.name.getText(source))
      .filter((name) => name.startsWith("omni_dispatch_v3_"))
      .sort();
  const fields = (node) =>
    node.members
      .map((m) => ({
        name: m.name.getText(source),
        optional: Boolean(m.questionToken),
        type: m.type.getText(source).replace(/\s+/g, " "),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const jsType = (type) =>
    ({
      uuid: "string",
      text: "string",
      timestamptz: "string",
      jsonb: "Json",
      int8: "number",
    })[type];
  await withDb(async (db) => {
    await db.exec(sql);
    const catalogTables = await query(
      db,
      `
      SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace
        AND relkind = 'r' AND starts_with(relname, 'omni_dispatch_v3_') ORDER BY relname
    `,
    );
    assert.deepEqual(
      v3Names(tables),
      catalogTables.map((t) => t.relname),
    );
    for (const { relname } of catalogTables) {
      const table = member(tables, relname);
      const attributes = await query(
        db,
        `
        SELECT a.attname AS name, t.typname AS type, a.attnotnull AS required,
          a.atthasdef AS defaulted, a.attidentity <> '' AS identity
        FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = 'public.${relname}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      `,
      );
      for (const operation of ["Row", "Insert", "Update"]) {
        const expected = attributes
          .map((a) => {
            assert.ok(jsType(a.type), `unmapped catalog type ${a.type}`);
            return {
              name: a.name,
              optional:
                operation === "Update" ||
                (operation === "Insert" && (!a.required || a.defaulted || a.identity)),
              type:
                a.identity && operation !== "Row"
                  ? "never"
                  : jsType(a.type) + (a.required ? "" : " | null"),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        assert.deepEqual(fields(member(table, operation)), expected, `${relname}.${operation}`);
      }
      assert.equal(member(table, "ComputedFields").getText(source), "never");
      const literal = (node) => {
        if (ts.isLiteralTypeNode(node)) {
          if (ts.isStringLiteral(node.literal)) return node.literal.text;
          if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return true;
          if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return false;
        }
        if (ts.isTupleTypeNode(node)) return node.elements.map(literal);
        assert.fail(`unexpected generated relationship type: ${node.getText(source)}`);
      };
      const relationships = member(table, "Relationships").elements.map((entry) =>
        Object.fromEntries(entry.members.map((m) => [m.name.getText(source), literal(m.type)])),
      );
      const foreignKeys = await query(
        db,
        `
        SELECT c.conname AS "foreignKeyName",
          ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(num,ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
          EXISTS (SELECT 1 FROM pg_constraint u WHERE u.conrelid = c.conrelid
            AND u.contype IN ('p','u') AND u.conkey = c.conkey) AS "isOneToOne",
          r.relname AS "referencedRelation",
          ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(num,ord)
            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS "referencedColumns"
        FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid
        WHERE c.conrelid = 'public.${relname}'::regclass AND c.contype = 'f' ORDER BY c.conname
      `,
      );
      assert.deepEqual(relationships, foreignKeys, `${relname}.Relationships`);
    }
    const catalogFunctions = await query(
      db,
      `
      SELECT p.proname, p.proargnames AS names,
        ARRAY(SELECT t.typname FROM unnest(p.proargtypes) WITH ORDINALITY AS a(oid,ord)
          JOIN pg_type t ON t.oid = a.oid ORDER BY a.ord) AS types
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND starts_with(p.proname, 'omni_dispatch_v3_') ORDER BY p.proname
    `,
    );
    assert.deepEqual(
      v3Names(functions),
      catalogFunctions.map((f) => f.proname),
    );
    for (const fn of catalogFunctions) {
      const generated = member(functions, fn.proname);
      const expected = fn.names
        .map((name, i) => ({
          name,
          optional: false,
          type: jsType(fn.types[i]),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(fields(member(generated, "Args")), expected, fn.proname);
      assert.equal(member(generated, "Returns").getText(source), "Json");
    }
  });
});

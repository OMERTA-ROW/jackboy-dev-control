// These roles are cluster-wide, not scoped to one database. Run only on an
// independently verified, dedicated disposable staging cluster.
export async function createStandins(query) {
  const rows = await query(`
    SELECT to_regnamespace('auth') IS NULL AS auth_absent,
      to_regnamespace('storage') IS NULL AS storage_absent,
      NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) AS roles_absent
  `);
  if (
    rows.length !== 1 ||
    !rows[0].auth_absent ||
    !rows[0].storage_absent ||
    !rows[0].roles_absent
  ) {
    throw new Error("standin_conflict");
  }
  await query(`
    CREATE ROLE anon NOLOGIN NOINHERIT;
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      email_confirmed_at timestamptz,
      raw_user_meta_data jsonb,
      created_at timestamptz DEFAULT now()
    );
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE SCHEMA storage;
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text NOT NULL,
      name text
    );
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON SCHEMA auth, storage FROM PUBLIC;
    REVOKE ALL ON auth.users, storage.objects FROM PUBLIC;
    REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
    GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  `);
}

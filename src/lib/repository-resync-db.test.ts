import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
it("atomic approved unlink preserves records, logs once, and rolls back stale batches", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE repository_resync_reviews(id uuid primary key,requested_by uuid,created_at timestamptz default now(),expires_at timestamptz default now()+interval '30 minutes',inventory jsonb,references_snapshot jsonb,approved_at timestamptz,replacements jsonb);
      CREATE TABLE user_roles(user_id uuid,role text);
      CREATE TABLE owner_projects(id uuid primary key,github_repo text,dev_enabled boolean,updated_at timestamptz);
      CREATE TABLE agent_projects(id uuid,repo_url text);
      CREATE TABLE foundry_tasks(id uuid,repo text,paused boolean,blocked_reason text,updated_at timestamptz);
      CREATE TABLE omni_jobs(id uuid,repo text,status text,last_error text);
      CREATE TABLE capability_grants(project_id uuid,capability text,last_verified_at timestamptz,last_error text,status text,updated_at timestamptz);
      CREATE TABLE audit_logs(actor uuid,action text,outcome text,detail jsonb);
      CREATE TABLE site_log(actor text,action text,category text,status text,summary text,detail jsonb);
      CREATE FUNCTION repository_reference_inventory() RETURNS jsonb LANGUAGE sql AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('table','owner_projects','id',id::text,'field','github_repo','value',github_repo,'mutable',true)),'[]') FROM owner_projects WHERE github_repo IS NOT NULL $$;`);
    await db.exec(await readFile("drizzle/migrations/0031_repository_resync_drift_removals.sql", "utf8"));
    const actor = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222", review = "33333333-3333-4333-8333-333333333333";
    await db.query("INSERT INTO user_roles VALUES ($1,'owner');", [actor]);
    await db.query("INSERT INTO owner_projects VALUES ($1,'OMERTA-ROW/Honeycomb',true,now())", [id]);
    await db.query("INSERT INTO repository_resync_reviews(id,requested_by,inventory,references_snapshot,report) SELECT $1,$2,'[]',repository_reference_inventory(),$3::jsonb", [review, actor, JSON.stringify({ rows: [{ repo: "OMERTA-ROW/Honeycomb", proposed: null, canApply: true }] })]);
    const change = JSON.stringify([{ from: "OMERTA-ROW/Honeycomb", to: null }]);
    // A stale second item must roll back the first unlink and its audit.
    await expect(db.query("SELECT apply_repository_resync_internal($1,$2,$3::jsonb)", [review, actor, JSON.stringify([{ from: "OMERTA-ROW/Honeycomb", to: null }, { from: "missing", to: null }])])).rejects.toThrow();
    expect((await db.query<{ github_repo: string }>("SELECT github_repo FROM owner_projects")).rows[0]?.github_repo).toBe("OMERTA-ROW/Honeycomb");
    await db.query("SELECT apply_repository_resync_internal($1,$2,$3::jsonb)", [review, actor, change]);
    expect((await db.query<{ github_repo: string | null; dev_enabled: boolean }>("SELECT github_repo,dev_enabled FROM owner_projects")).rows[0]).toEqual({ github_repo: null, dev_enabled: false });
    await db.query("SELECT apply_repository_resync_internal($1,$2,$3::jsonb)", [review, actor, change]);
    expect((await db.query("SELECT * FROM audit_logs")).rows).toHaveLength(1);
    expect((await db.query("SELECT * FROM site_log")).rows).toHaveLength(1);
  } finally { await db.close(); }
}, 20000);
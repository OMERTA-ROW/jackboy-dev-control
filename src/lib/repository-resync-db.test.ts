import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
it("atomic approved unlink preserves records, logs once, and rolls back stale batches", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE repository_resync_reviews(id uuid primary key,requested_by uuid,created_at timestamptz default now(),expires_at timestamptz default now()+interval '30 minutes',inventory jsonb,references_snapshot jsonb,approved_at timestamptz,replacements jsonb);
      CREATE TABLE user_roles(user_id uuid,role text);
      CREATE TABLE owner_projects(id uuid primary key,github_repo text,dev_enabled boolean,updated_at timestamptz,name text);
      CREATE TABLE agent_projects(id uuid,repo_url text,name text);
      CREATE TABLE foundry_tasks(id uuid,repo text,paused boolean,blocked_reason text,updated_at timestamptz);
      CREATE TABLE omni_jobs(id uuid,repo text,status text,last_error text);
      CREATE TABLE capability_grants(project_id uuid,capability text,last_verified_at timestamptz,last_error text,status text,updated_at timestamptz);
      CREATE TABLE audit_logs(actor uuid,action text,outcome text,detail jsonb);
      CREATE TABLE site_log(actor text,action text,category text,status text,summary text,detail jsonb);
      CREATE FUNCTION repository_reference_inventory() RETURNS jsonb LANGUAGE sql AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('table','owner_projects','id',id::text,'field','github_repo','value',github_repo,'mutable',true)),'[]') FROM owner_projects WHERE github_repo IS NOT NULL $$;`);
    await db.exec(await readFile("drizzle/migrations/0031_repository_resync_drift_removals.sql", "utf8"));
    const actor = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222", review = "33333333-3333-4333-8333-333333333333";
    await db.query("INSERT INTO user_roles VALUES ($1,'owner');", [actor]);
    await db.query("INSERT INTO owner_projects(id,github_repo,dev_enabled,updated_at) VALUES ($1,'OMERTA-ROW/Honeycomb',true,now())", [id]);
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
    await db.exec(await readFile("drizzle/migrations/0033_unified_project_repository_resync.sql", "utf8"));
    const next = "44444444-4444-4444-8444-444444444444";
    const agent = "55555555-5555-4555-8555-555555555555";
    await db.query("UPDATE owner_projects SET name='Old Vault' WHERE id=$1", [id]);
    await db.query("INSERT INTO agent_projects VALUES($1,null,'Old Vault')", [agent]);
    const profiles = [{ projectId: id, oldName: "Old Vault", oldRepo: null, newName: "honeycomb-vault", agentProfiles: [{ id: agent, name: "Old Vault", repo_url: null }] }];
    const missing = [{ from: `project:${id}`, to: "OMERTA-ROW/honeycomb-vault", profiles }];
    await db.query("INSERT INTO repository_resync_reviews(id,requested_by,inventory,references_snapshot,report) VALUES($1,$2,$3,'[]',$4)", [next, actor, JSON.stringify(["OMERTA-ROW/honeycomb-vault"]), JSON.stringify({ rows: [{ repo: `project:${id}`, proposed: "OMERTA-ROW/honeycomb-vault", group: "missing", canApply: true, profiles }] })]);
    await expect(db.query("SELECT apply_project_repository_resync($1,$2,$3)", [next, actor, JSON.stringify([{ ...missing[0], profiles: [{ ...profiles[0], newName: "tampered" }] }])])).rejects.toThrow();
    expect((await db.query("SELECT github_repo FROM owner_projects")).rows[0]?.github_repo).toBeNull();
    await db.query("SELECT apply_project_repository_resync($1,$2,$3)", [next, actor, JSON.stringify(missing)]);
    expect((await db.query("SELECT github_repo,name,dev_enabled FROM owner_projects")).rows[0]).toEqual({ github_repo: "OMERTA-ROW/honeycomb-vault", name: "honeycomb-vault", dev_enabled: false });
    expect((await db.query("SELECT repo_url,name FROM agent_projects")).rows[0]).toEqual({ repo_url: "https://github.com/OMERTA-ROW/honeycomb-vault", name: "honeycomb-vault" });
    await db.query("SELECT apply_project_repository_resync($1,$2,$3)", [next, actor, JSON.stringify(missing)]);
    expect((await db.query("SELECT * FROM audit_logs WHERE action='projects.resync.approved'")).rows).toHaveLength(1);
  } finally { await db.close(); }
}, 20000);
// Real PostgreSQL only. Every database is disposable and restricted to loopback by openDb.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  closeAdmin,
  openDb,
  replay,
  setActivatedControls,
  skipNoPg,
  supabaseStubs,
  waitForLock,
} from "./helpers/staging-pg.mjs";

after(closeAdmin);
const owner = "11111111-1111-4111-8111-111111111111";
const project = "33333333-3333-4333-8333-333333333333";
const approval = "44444444-4444-4444-8444-444444444444";
const proof = "55555555-5555-4555-8555-555555555555";
const job = "66666666-6666-4666-8666-666666666666";
const token = "a".repeat(64);

for (const mode of ["emergency_stop", "kill_switch"]) {
  test(
    `permit issuance is serialized against ${mode}, including the formerly vulnerable interleaving`,
    { skip: skipNoPg, timeout: 60000 },
    async () => {
      const db = await openDb();
      const blocker = await db.pool.connect();
      const issuer = await db.pool.connect();
      const stopper = await db.pool.connect();
      try {
        await db.exec(supabaseStubs);
        await replay(db, { through: "0066" });
        await db.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
        await db.query("INSERT INTO public.user_roles(user_id,role) VALUES($1,'owner')", [owner]);
        await db.query(
          "INSERT INTO public.owner_projects(id,name,created_by) VALUES($1,'OMNI',$2)",
          [project, owner],
        );
        await db.query(
          "INSERT INTO public.omni_inbound_jobs(id,client_id,project_id,approval_id,kind,status,deadline) VALUES($1,'OMNI',$2,$3,'protocol.self-test','completed',now())",
          [proof, project, approval],
        );
        await db.query(
          "INSERT INTO public.omni_link_sessions VALUES($1,'OMNI',$2,$3,now()+interval '4 minutes')",
          [token, project, approval],
        );
        await db.query(
          "INSERT INTO public.omni_autonomy_authorizations(owner_id,client_id,project_id,approval_id,step8_job_id,expires_at) VALUES($1,'OMNI',$2,$3,$4,now()+interval '1 hour')",
          [owner, project, approval, proof],
        );
        await db.exec(
          "INSERT INTO public.automation_policy(id,paused) VALUES(1,false) ON CONFLICT(id) DO UPDATE SET paused=false",
        );
        await setActivatedControls(
          db,
          "UPDATE public.code_runtime_controls SET enabled=true,kill_switch=false",
        );
        await db.exec(`CREATE FUNCTION public.test_wait_permit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(818181); RETURN NEW; END $$;
          CREATE TRIGGER test_wait_permit_insert BEFORE INSERT ON public.omni_execution_permits
          FOR EACH ROW EXECUTE FUNCTION public.test_wait_permit_insert();`);
        const args = {
          clientId: "OMNI",
          projectId: project,
          approvalId: approval,
          ownerId: owner,
          approvalExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          tokenHash: token,
          nonce: "b".repeat(32),
          jobId: job,
          kind: "autonomous",
          digest: "c".repeat(64),
          estimateUsd: 1,
        };
        const stopSql =
          mode === "emergency_stop"
            ? "UPDATE public.code_runtime_controls SET kill_switch=true"
            : "UPDATE public.automation_policy SET paused=true WHERE id=1";
        const issuerPid = (await issuer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const stopPid = (await stopper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

        // 0066 alone: stop commits while a previously checked issuance is held at INSERT.
        await blocker.query("SELECT pg_advisory_lock(818181)");
        const oldIssue = issuer.query(
          "SELECT public.omni_execution_permit_action('request',$1::jsonb) AS r",
          [JSON.stringify(args)],
        );
        await waitForLock(db, issuerPid);
        await stopper.query(stopSql);
        await blocker.query("SELECT pg_advisory_unlock(818181)");
        assert.equal((await oldIssue).rows[0].r.http, 200);
        assert.equal(
          (
            await db.query("SELECT status FROM public.omni_execution_permits WHERE job_id=$1", [
              job,
            ])
          ).rows[0].status,
          "active",
        );

        await db.query("DELETE FROM public.omni_execution_permits WHERE job_id=$1", [job]);
        await db.exec("UPDATE public.automation_policy SET paused=false WHERE id=1");
        await setActivatedControls(
          db,
          "UPDATE public.code_runtime_controls SET enabled=true,kill_switch=false",
        );
        await db.exec(
          await readFile("drizzle/migrations/0067_omni_permit_stop_serialization.sql", "utf8"),
        );
        assert.equal(
          (
            await db.query(
              "SELECT has_function_privilege('service_role','public.omni_execution_permit_action_unlocked(text,jsonb)','EXECUTE') AS allowed",
            )
          ).rows[0].allowed,
          false,
        );
        args.nonce = "d".repeat(32);
        await blocker.query("SELECT pg_advisory_lock(818181)");
        const newIssue = issuer.query(
          "SELECT public.omni_execution_permit_action('request',$1::jsonb) AS r",
          [JSON.stringify(args)],
        );
        await waitForLock(db, issuerPid);
        const stop = stopper.query(stopSql);
        await waitForLock(db, stopPid);
        await blocker.query("SELECT pg_advisory_unlock(818181)");
        assert.equal((await newIssue).rows[0].r.http, 200);
        await stop;
        assert.equal(
          (
            await db.query("SELECT status FROM public.omni_execution_permits WHERE job_id=$1", [
              job,
            ])
          ).rows[0].status,
          "revoked",
        );
      } finally {
        await blocker.query("SELECT pg_advisory_unlock_all()");
        blocker.release();
        issuer.release();
        stopper.release();
        await db.close();
      }
    },
  );
}

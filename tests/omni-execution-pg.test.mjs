import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  openDb,
  supabaseStubs,
  replay,
  closeAdmin,
  skipNoPg,
  setActivatedControls,
} from "./helpers/staging-pg.mjs";
after(closeAdmin);
const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const approval = "33333333-3333-4333-8333-333333333333";
const tokenHash = "c".repeat(64);
async function fixture() {
  const db = await openDb();
  try {
    await db.exec(supabaseStubs);
    await replay(db);
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await db.query("INSERT INTO public.user_roles(user_id,role) VALUES($1,'owner')", [owner]);
    await db.query(
      "INSERT INTO public.owner_projects(id,name,lovable_url,created_by) VALUES($1,'fixture','https://fixture.invalid',$2)",
      [project, owner],
    );
    await db.exec("UPDATE public.automation_policy SET paused=false");
    // Synthetic readiness stand-ins; never provider or deployment evidence.
    await db.exec(
      'CREATE OR REPLACE FUNCTION public.code_total_spend_guard_status() RETURNS jsonb LANGUAGE sql AS $$ SELECT \'{"enforced":true,"limit_usd":10}\'::jsonb $$',
    );
    await db.exec(
      "CREATE OR REPLACE FUNCTION public.code_spend_meter_status() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{\"ok\":true}'::jsonb $$",
    );
    await db.query(
      "SELECT public.set_code_provider_hard_cap_verified($1,true,'Synthetic isolated fixture only')",
      [owner],
    );
    await db.query(
      "INSERT INTO public.omni_link_approval(id,approval_id,expires_at,saved_by,saved_at) VALUES(1,$1,now()+interval '1 hour',$2,now()-interval '1 minute')",
      [approval, owner],
    );
    const proof = randomUUID();
    await db.query(
      `INSERT INTO public.omni_inbound_jobs(id,client_id,project_id,approval_id,kind,status,deadline,result)
       VALUES($1,'fixture',$2,$3,'protocol.self-test','completed',now(),
       '{"passed":true,"checks":3,"runner":"restricted-protocol-self-test"}')`,
      [proof, project, approval],
    );
    await db.query(
      "INSERT INTO public.omni_link_sessions VALUES($1,'fixture',$2,$3,now()+interval '5 minutes')",
      [tokenHash, project, approval],
    );
    await db.query(
      "INSERT INTO public.owner_passkeys(user_id,credential_id,public_key) VALUES($1,'fixture-passkey','synthetic')",
      [owner],
    );
    const grant = (
      await db.query(
        "INSERT INTO public.step_up_grants(user_id,action,target,credential_id,expires_at) VALUES($1,'omni_autonomy',$2,'fixture-passkey',now()+interval '5 minutes') RETURNING id",
        [owner, `omni-autonomy:${approval}`],
      )
    ).rows[0].id;
    const authorized = (
      await db.query(
        "SELECT public.omni_autonomy_authorization_action('authorize',$1,'fixture',$2,$3,true,'Synthetic fixture only') AS r",
        [owner, project, grant],
      )
    ).rows[0].r;
    assert.equal(authorized.ok, true, JSON.stringify(authorized));
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
async function permit(db, op, extra = {}) {
  const result = (
    await db.query("SELECT public.omni_execution_permit_action($1,$2::jsonb) AS r", [
      op,
      JSON.stringify({
        clientId: "fixture",
        ownerId: owner,
        projectId: project,
        approvalId: approval,
        approvalExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tokenHash,
        nonce: randomUUID().replaceAll("-", ""),
        ...extra,
      }),
    ])
  ).rows[0].r;
  if (result.http !== 200) throw new Error(`${result.error}: ${result.reason ?? result.http}`);
  return result;
}
const control = async (db, op, args = {}) => {
  if (op === "permit" || op === "release") {
    const result = await permit(db, op === "permit" ? "request" : "release", {
      jobId: args.jobId,
      kind: "autonomous",
      digest: args.planSha256,
      estimateUsd: args.estimateUsd,
    });
    return result.permit;
  }
  return (
    await db.query("SELECT public.omni_execution_control($1,$2,$3,$4,$5::jsonb) AS state", [
      owner,
      project,
      approval,
      op,
      JSON.stringify({ ...args, clientId: "fixture" }),
    ])
  ).rows[0].state;
};
const connect = (db) =>
  control(db, "connect", {
    operationId: randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
async function authorized(db, ttlMs = 50_000) {
  await connect(db);
  await control(db, "verify", { passed: true, release: "omni-bounded-plan-1" });
  await control(db, "configure", { release: "omni-bounded-plan-1" });
  await setActivatedControls(
    db,
    "UPDATE public.code_runtime_controls SET enabled=true,kill_switch=false",
  );
  await control(db, "arm", { release: "omni-bounded-plan-1" });
  const args = {
    jobId: randomUUID(),
    planSha256: "a".repeat(64),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    release: "omni-bounded-plan-1",
  };
  await control(db, "authorize", args);
  await control(db, "permit", { ...args, estimateUsd: 0.01 });
  await control(db, "lease", args);
  return args;
}
test(
  "missing, stale and disconnected Mothership leases fail closed without reviving a job",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      await db.exec("UPDATE public.omni_execution_jobs SET mothership_lease_expires_at=NULL");
      assert.equal((await control(db, "claim", args)).allowed, false);
      await assert.rejects(control(db, "lease", args));
      await db.query("SELECT public.omni_execution_cancel_ack($1,$2)", [
        args.jobId,
        args.planSha256,
      ]);
      await control(db, "release", args);
      const next = { ...args, jobId: randomUUID() };
      await control(db, "authorize", next);
      await control(db, "permit", { ...next, estimateUsd: 0.01 });
      await control(db, "lease", next);
      assert.equal((await control(db, "claim", next)).allowed, true);
      // Real elapsed database time: Mothership has stopped renewing, even though its permit remains valid.
      await db.exec("SELECT pg_sleep(1.05)");
      assert.equal((await control(db, "permission", next)).allowed, false);
      await assert.rejects(control(db, "lease", next));
      assert.equal((await control(db, "safety")).activePermits, 0);
    } finally {
      await db.close();
    }
  },
);
test(
  "concurrent permit renewal, lease and Emergency Stop serialize; no permit survives revocation",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      assert.equal((await control(db, "claim", args)).allowed, true);
      await Promise.allSettled([
        control(db, "permit", { ...args, estimateUsd: 0.01 }),
        control(db, "lease", args),
        db.query("SELECT public.engage_code_kill_switch($1)", [owner]),
      ]);
      const state = await control(db, "safety");
      assert.equal(state.emergencyStop, true);
      assert.equal(state.armed, false);
      assert.equal(state.cancellationPending, true);
      assert.equal(state.activePermits, 0);
      assert.equal((await control(db, "permission", args)).allowed, false);
      await assert.rejects(control(db, "permit", { ...args, estimateUsd: 0.01 }));
      await assert.rejects(control(db, "lease", args));
      await assert.rejects(control(db, "authorize", { ...args, jobId: randomUUID() }));
    } finally {
      await db.close();
    }
  },
);
test(
  "concurrent permit issuance and release never reopen a revoked job",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      await Promise.allSettled([
        control(db, "permit", { ...args, estimateUsd: 0.01 }),
        control(db, "release", args),
      ]);
      assert.equal((await control(db, "claim", args)).allowed, false);
      assert.equal((await control(db, "safety")).activePermits, 0);
      await assert.rejects(control(db, "permit", { ...args, estimateUsd: 0.01 }));
    } finally {
      await db.close();
    }
  },
);
test(
  "configuration is persisted without enabling CODE, OMNI, or releasing Stop",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = {
        operationId: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      await control(db, "connect", args);
      await control(db, "connect", args);
      await assert.rejects(control(db, "configure", { release: "omni-bounded-plan-1" }));
      await control(db, "verify", { passed: true, release: "omni-bounded-plan-1" });
      const state = await control(db, "configure", { release: "omni-bounded-plan-1" });
      assert.equal(state.connected, true);
      assert.equal(state.configured, true);
      assert.equal(state.armed, false);
      assert.equal(state.emergencyStop, true);
      assert.equal(
        (await db.query("SELECT enabled FROM public.code_runtime_controls")).rows[0].enabled,
        false,
      );
      await assert.rejects(control(db, "arm", { release: "omni-bounded-plan-1" }));
      await assert.rejects(
        db.exec(
          "SET ROLE authenticated; SELECT public.omni_execution_control(NULL,NULL,NULL,'safety','{}');",
        ),
      );
    } finally {
      await db.close();
    }
  },
);
test(
  "concurrent execution claims admit once and Stop atomically cancels and disarms",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      const results = await Promise.all([control(db, "claim", args), control(db, "claim", args)]);
      assert.equal(results.filter((state) => state.allowed).length, 1);
      assert.equal((await control(db, "permission", args)).allowed, true);
      await db.query("SELECT public.engage_code_kill_switch($1)", [owner]);
      const state = await control(db, "safety");
      assert.equal(state.armed, false);
      assert.equal(state.emergencyStop, true);
      assert.equal(state.cancellationPending, true);
      assert.equal((await control(db, "permission", args)).allowed, false);
      await control(db, "finish", { ...args, outcome: "completed" });
      assert.equal(
        (await db.query("SELECT state FROM public.omni_execution_jobs")).rows[0].state,
        "cancelled",
      );
    } finally {
      await db.close();
    }
  },
);
test(
  "cancellation acknowledgement is scoped, idempotent and atomic with its audit",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      await control(db, "disarm");
      await assert.rejects(
        db.query("SELECT public.omni_execution_cancel_ack($1,$2)", [args.jobId, "b".repeat(64)]),
      );
      await db.exec(
        "ALTER TABLE public.audit_logs ADD CONSTRAINT fixture_ack_reject CHECK(action <> 'omni.execution.cancel_ack') NOT VALID",
      );
      await assert.rejects(
        db.query("SELECT public.omni_execution_cancel_ack($1,$2)", [args.jobId, args.planSha256]),
      );
      assert.equal(
        (await db.query("SELECT state FROM public.omni_execution_jobs")).rows[0].state,
        "cancel_requested",
      );
      await db.exec("ALTER TABLE public.audit_logs DROP CONSTRAINT fixture_ack_reject");
      await db.query("SELECT public.omni_execution_cancel_ack($1,$2)", [
        args.jobId,
        args.planSha256,
      ]);
      await db.query("SELECT public.omni_execution_cancel_ack($1,$2)", [
        args.jobId,
        args.planSha256,
      ]);
      assert.equal(
        (await db.query("SELECT state FROM public.omni_execution_jobs")).rows[0].state,
        "cancelled",
      );
    } finally {
      await db.close();
    }
  },
);
test(
  "parallel authorizations admit one global slot and expired verification blocks arming",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const first = await authorized(db);
      await control(db, "disarm");
      await db.query("SELECT public.omni_execution_cancel_ack($1,$2)", [
        first.jobId,
        first.planSha256,
      ]);
      await control(db, "arm", { release: "omni-bounded-plan-1" });
      const results = await Promise.allSettled([
        control(db, "authorize", { ...first, jobId: randomUUID() }),
        control(db, "authorize", { ...first, jobId: randomUUID() }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      await db.exec(
        "UPDATE public.omni_execution_connections SET verified_at=now()-interval '16 minutes',armed=false",
      );
      await assert.rejects(control(db, "arm", { release: "omni-bounded-plan-1" }));
    } finally {
      await db.close();
    }
  },
);
test(
  "durable nonces reject concurrent replay, bound requests and clean only expired execution entries",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const nonce = "a".repeat(32);
      const results = await Promise.allSettled([
        db.query("SELECT public.claim_omni_execution_nonce('fixture',$1)", [nonce]),
        db.query("SELECT public.claim_omni_execution_nonce('fixture',$1)", [nonce]),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      await db.exec(
        "INSERT INTO public.omni_callback_nonces(nonce,received_at) VALUES('legacy-fixture',now()-interval '2 minutes'),('execution:fixture:expired',now()-interval '2 minutes')",
      );
      await db.query("SELECT public.claim_omni_execution_nonce('fixture',$1)", ["b".repeat(32)]);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM public.omni_callback_nonces WHERE nonce='legacy-fixture'",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM public.omni_callback_nonces WHERE nonce='execution:fixture:expired'",
          )
        ).rows[0].n,
        0,
      );
      await db.exec(
        "INSERT INTO public.omni_callback_nonces(nonce) SELECT 'execution:fixture:'||md5(i::text) FROM generate_series(1,398) i",
      );
      await assert.rejects(
        db.query("SELECT public.claim_omni_execution_nonce('fixture',$1)", ["c".repeat(32)]),
      );
    } finally {
      await db.close();
    }
  },
);
test(
  "expired plans, changed hashes and global Kill Switch fail closed",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db, 1_000);
      await assert.rejects(control(db, "authorize", { ...args, planSha256: "b".repeat(64) }));
      await assert.rejects(
        db.exec("UPDATE public.omni_execution_jobs SET expires_at=now()-interval '1 second'"),
      );
      await db.exec("SELECT pg_sleep(1.1)");
      assert.equal((await control(db, "claim", args)).allowed, false);
      await db.exec("UPDATE public.automation_policy SET paused=true");
      const state = await control(db, "safety");
      assert.equal(state.killSwitch, true);
      assert.equal(state.armed, false);
    } finally {
      await db.close();
    }
  },
);
test("audit failure rolls back backend connection activation", { skip: skipNoPg }, async () => {
  const db = await fixture();
  try {
    await db.exec(
      "ALTER TABLE public.audit_logs ADD CONSTRAINT fixture_reject CHECK(action <> 'omni.execution.connect') NOT VALID",
    );
    await assert.rejects(connect(db));
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM public.omni_execution_connections")).rows[0]
        .n,
      0,
    );
  } finally {
    await db.close();
  }
});

test(
  "signed sessions validate token and scope; permit renewal, release and terminal jobs never reopen",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      const hash = "c".repeat(64);
      const session = async (token, op, values = {}) => {
        const result = await permit(db, op === "permit" ? "request" : op, {
          tokenHash: token,
          jobId: values.jobId,
          kind: "autonomous",
          digest: values.planSha256,
          estimateUsd: values.estimateUsd,
        });
        return op === "safety" ? result.safety : result.permit;
      };
      await assert.rejects(session("d".repeat(64), "safety"));
      assert.equal((await session(hash, "safety")).activePermits, 1);
      const renewed = await session(hash, "permit", { ...args, estimateUsd: 0.01 });
      assert.equal(renewed.renewals, 1);
      await assert.rejects(
        session(hash, "permit", { ...args, planSha256: "e".repeat(64), estimateUsd: 0.01 }),
      );
      assert.equal((await control(db, "claim", args)).allowed, true);
      await control(db, "finish", { ...args, outcome: "completed" });
      await session(hash, "release", { jobId: args.jobId });
      await assert.rejects(db.exec("UPDATE public.omni_execution_jobs SET state='authorized'"));
      await assert.rejects(session(hash, "permit", { ...args, estimateUsd: 0.01 }));
      await db.exec("UPDATE public.omni_link_sessions SET expires_at=now()-interval '1 second'");
      await assert.rejects(session(hash, "safety"));
    } finally {
      await db.close();
    }
  },
);
test(
  "missing and lapsed permits or stale independent verification cannot claim execution",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      await db.exec(
        "UPDATE public.omni_execution_jobs SET permit_expires_at=now()-interval '1 second'",
      );

      await assert.rejects(control(db, "permit", { ...args, estimateUsd: 0.01 }));
      assert.equal((await control(db, "claim", args)).allowed, false);
      await db.query("SELECT public.omni_execution_cancel_ack($1,$2)", [
        args.jobId,
        args.planSha256,
      ]);
      const next = { ...args, jobId: randomUUID() };
      await control(db, "authorize", next);
      assert.equal((await control(db, "claim", next)).allowed, false);
      await db.exec("UPDATE public.omni_execution_connections SET verified_at=NULL");
      await assert.rejects(control(db, "authorize", { ...args, jobId: randomUUID() }));
    } finally {
      await db.close();
    }
  },
);

test(
  "an issued permit is not Running without a fresh worker claim and permission heartbeat",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      assert.equal((await control(db, "safety")).running, false);
      assert.equal((await control(db, "claim", args)).allowed, true);
      assert.equal((await control(db, "safety")).running, true);
      await db.exec(
        "UPDATE public.omni_execution_jobs SET last_permission_at=now()-interval '2 seconds'",
      );
      const stale = await control(db, "safety");
      assert.equal(stale.running, false);
      assert.equal(stale.executionReady, false);
      assert.equal((await control(db, "permission", args)).allowed, true);
      assert.equal((await control(db, "safety")).running, true);
      await control(db, "finish", { ...args, outcome: "completed" });
      assert.equal((await control(db, "safety")).running, false);
    } finally {
      await db.close();
    }
  },
);

test(
  "upstream owner revocation cancels the bounded job and cannot be bypassed by its mirror",
  { skip: skipNoPg },
  async () => {
    const db = await fixture();
    try {
      const args = await authorized(db);
      assert.equal((await control(db, "claim", args)).allowed, true);
      const native = (await db.query("SELECT id,reserved_usd FROM public.omni_execution_permits"))
        .rows[0];
      const mirror = (await db.query("SELECT permit_id FROM public.omni_execution_jobs")).rows[0];
      assert.equal(mirror.permit_id, native.id);
      assert.equal(Number(native.reserved_usd), 1);
      await db.query(
        "SELECT public.omni_autonomy_authorization_action('revoke',$1,'fixture',$2,NULL,NULL,'Synthetic revoke')",
        [owner, project],
      );
      assert.equal((await control(db, "safety")).executionReady, false);
      assert.equal((await control(db, "permission", args)).allowed, false);
      assert.equal((await control(db, "safety")).cancellationPending, true);
      await assert.rejects(control(db, "lease", args), /owner authorization/);
      await assert.rejects(
        control(db, "configure", { release: "omni-bounded-plan-1" }),
        /owner authorization/,
      );
      await assert.rejects(control(db, "permit", { ...args, estimateUsd: 0.01 }));
    } finally {
      await db.close();
    }
  },
);

for (const [fn, body, reason] of [
  ["code_spend_meter_status", '{"ok":false}', "meter_untrusted"],
  ["code_total_spend_guard_status", '{"enforced":false,"limit_usd":10}', "gateway_unenforced"],
]) {
  test(
    `permit admission and renewal recheck ${reason} and halt the actual bounded claim`,
    { skip: skipNoPg },
    async () => {
      const db = await fixture();
      try {
        const args = await authorized(db);
        assert.equal((await control(db, "claim", args)).allowed, true);
        await db.exec(
          `CREATE OR REPLACE FUNCTION public.${fn}() RETURNS jsonb LANGUAGE sql AS $$ SELECT '${body}'::jsonb $$`,
        );
        const safety = (await permit(db, "safety")).safety;
        assert.equal(safety.autonomousAllowed, false);
        assert.equal(safety.blockedBy, reason);
        await assert.rejects(
          control(db, "permit", { ...args, estimateUsd: 0.01 }),
          new RegExp(reason),
        );
        await assert.rejects(
          permit(db, "request", {
            jobId: randomUUID(),
            kind: "autonomous",
            digest: "b".repeat(64),
            estimateUsd: 1,
          }),
          new RegExp(reason),
        );
        assert.equal(
          (await db.query("SELECT count(*)::int AS n FROM public.omni_execution_permits")).rows[0]
            .n,
          1,
        );
        assert.equal((await control(db, "permission", args)).allowed, false);
        assert.equal(
          (await db.query("SELECT status FROM public.omni_execution_permits")).rows[0].status,
          "revoked",
        );
      } finally {
        await db.close();
      }
    },
  );
}

for (const mode of ["emergency_stop", "global_stop", "code_off"]) {
  test(
    `${mode} generation survives failed revocation and permanently rejects the old permit after release`,
    { skip: skipNoPg },
    async () => {
      const db = await fixture();
      try {
        await setActivatedControls(
          db,
          "UPDATE public.code_runtime_controls SET enabled=true,kill_switch=false",
        );
        const jobId = randomUUID();
        const input = { jobId, kind: "autonomous", digest: "f".repeat(64), estimateUsd: 1 };
        await permit(db, "request", input);
        await db.exec(
          "ALTER TABLE public.omni_execution_permits ADD CONSTRAINT fixture_revoke_failure CHECK(status<>'revoked') NOT VALID",
        );
        await db.exec(
          mode === "global_stop"
            ? "UPDATE public.automation_policy SET paused=true"
            : mode === "code_off"
              ? "UPDATE public.code_runtime_controls SET enabled=false"
              : "UPDATE public.code_runtime_controls SET kill_switch=true",
        );
        assert.equal(
          (await db.query("SELECT status FROM public.omni_execution_permits")).rows[0].status,
          "active",
        );
        await db.exec(
          "ALTER TABLE public.omni_execution_permits DROP CONSTRAINT fixture_revoke_failure",
        );
        // Isolated fixture models a subsequent explicit owner release, never an application action.
        await db.exec("UPDATE public.automation_policy SET paused=false");
        await setActivatedControls(
          db,
          "UPDATE public.code_runtime_controls SET enabled=true,kill_switch=false",
        );
        await assert.rejects(permit(db, "request", input), /permit_stopped/);
        assert.equal(
          (await db.query("SELECT status FROM public.omni_execution_permits")).rows[0].status,
          "revoked",
        );
        assert.equal((await permit(db, "request", { ...input, jobId: randomUUID() })).http, 200);
        for (const fn of [
          "omni_execution_permit_action_unlocked",
          "omni_execution_permit_action_without_worker",
          "omni_execution_permit_action_without_safety_generation",
        ]) {
          assert.equal(
            (
              await db.query(
                `SELECT has_function_privilege('service_role','public.${fn}(text,jsonb)','EXECUTE') AS allowed`,
              )
            ).rows[0].allowed,
            false,
          );
        }
      } finally {
        await db.close();
      }
    },
  );
}

// Paired transport checks only: the companion executor stays disabled and cannot run commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { signedExecutorRequest } from "../src/lib/omni-executor-client.ts";

const root = process.env.MOTHERSHIP_TEST_ROOT;
test(
  "Jackboy accepts the PR12 executor proof and refuses replay, bad auth and unowned cancellation",
  { skip: root ? false : "Set MOTHERSHIP_TEST_ROOT to the reviewed executor checkout" },
  async () => {
    const { createExecutor } = await import(
      pathToFileURL(join(root, "services/omni-autonomous/executor.mjs")).href
    );
    const origin = "http://omni-autonomous-executor.railway.internal:8080";
    const controlSecret = "synthetic-contract-control-secret-for-tests";
    const prohibited = () => {
      assert.fail("Contract validation must not create workspaces, permissions or subprocesses");
    };
    const executor = createExecutor(
      { enabled: false, controlSecret, reviewedRelease: "omni-bounded-plan-1" },
      { run: prohibited, permission: prohibited, workspace: prohibited },
    );
    const originalFetch = globalThis.fetch;
    let lastRequest;
    globalThis.fetch = async (url, init) => {
      lastRequest = new Request(url, init);
      return executor.handle(lastRequest.clone());
    };
    try {
      assert.deepEqual(await signedExecutorRequest(origin, controlSecret, "inspect", {}), {
        release: "omni-bounded-plan-1",
        enabled: false,
        reviewedRelease: "omni-bounded-plan-1",
      });
      assert.equal((await executor.handle(lastRequest.clone())).status, 409);
      const bad = lastRequest.clone();
      bad.headers.set("X-Executor-Signature", "0".repeat(64));
      assert.equal((await executor.handle(bad)).status, 401);
      await assert.rejects(
        signedExecutorRequest(origin, controlSecret, "cancel", {
          jobId: "11111111-1111-4111-8111-111111111111",
          planSha256: "a".repeat(64),
        }),
        /Executor proof or status failed/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await executor.close();
    }
  },
);

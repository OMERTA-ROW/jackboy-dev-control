import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

test("built Railway runner serves JSON refusals on loopback without executing a job", { timeout: 30_000 }, async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      NITRO_HOST: "127.0.0.1",
      PORT: String(port),
      RAILWAY_ENVIRONMENT_ID: "isolated-test",
      OMNI_LINK_RUNNER_MODE: "true",
      OMNI_LINK_NODE_RUNNER_ENABLED: "true",
      OMNI_LINK_REMOTE_RUNNER_SECRET: "local-test-only-".repeat(4),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit");
  const origin = `http://127.0.0.1:${port}`;
  try {
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, output);
      try {
        response = await fetch(`${origin}/api/public/omni/runner`, { signal: AbortSignal.timeout(1000) });
      } catch (error) {
        if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
      }
      if (response) break;
      await delay(100);
    }
    assert.ok(response, output);
    assert.equal(response.status, 405);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(response.headers.get("allow"), "POST");
    assert.deepEqual(await response.json(), { error: "post_required" });
    assert.equal((await fetch(`${origin}/settings`)).status, 404);
    const unsigned = await fetch(`${origin}/api/public/omni/runner`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(unsigned.status, 401);
    assert.match(unsigned.headers.get("content-type"), /application\/json/);
  } finally {
    child.kill("SIGTERM");
    if (!await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })])) {
      child.kill("SIGKILL");
      await exited;
    }
  }
});

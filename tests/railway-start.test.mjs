import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

test("Railway build is a Node listener without changing the Lovable build", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(scripts.build, "vite build");
  assert.equal(scripts["build:railway"], "NITRO_PRESET=node-server vite build");
  assert.equal(scripts.start, "NITRO_HOST=0.0.0.0 node .output/server/index.mjs");
  const metadata = JSON.parse(readFileSync(".output/nitro.json", "utf8"));
  assert.equal(metadata.preset.replaceAll("_", "-"), "node-server");
  assert.equal(metadata.serverEntry, "server/index.mjs");
});

test(
  "production entry stays running on PORT, serves assets and retains owner/OMNI gates",
  {
    timeout: 30_000,
  },
  async () => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address();
    await new Promise((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );

    // Deliberately omit credentials, provider configuration, schedules and inherited runtime grants.
    const child = spawn(process.execPath, [".output/server/index.mjs"], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        NITRO_HOST: "0.0.0.0",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(child, "exit");
    try {
      const origin = `http://127.0.0.1:${port}`;
      let response;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, `Server exited before readiness: ${output}`);
        try {
          response = await fetch(`${origin}/favicon.ico`, { signal: AbortSignal.timeout(1000) });
        } catch (error) {
          if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
        }
        if (response) break;
        await delay(100);
      }
      assert.ok(response, `Server did not listen on Railway PORT: ${output}`);
      assert.equal(response.status, 200);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        readFileSync("public/favicon.ico"),
      );
      const home = await fetch(origin, { signal: AbortSignal.timeout(5000) });
      assert.equal(home.status, 200, output);
      assert.match(home.headers.get("content-type"), /text\/html/);
      assert.match(await home.text(), /<!DOCTYPE html>/i);
      const manifest = await fetch(`${origin}/api/agent/manifest`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(manifest.status, 401, output);
      assert.deepEqual(await manifest.json(), { error: "Owner sign-in required." });
      const link = await fetch(`${origin}/api/public/omni/link`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(link.status, 503, output);
      assert.deepEqual(await link.json(), { error: "link_disabled" });
      await delay(200);
      assert.equal(child.exitCode, null, `Server did not remain running: ${output}`);
    } finally {
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(5000, false, { ref: false }),
      ]);
      if (!stopped) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
);

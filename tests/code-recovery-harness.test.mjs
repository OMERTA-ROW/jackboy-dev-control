import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { verifyIsolation } from "../scripts/rehearse-code-recovery.mjs";

const isolated = () => ({
  HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, PortBindings: {}, Binds: null },
  Config: { Labels: { "jackboy.rehearsal": "0060" } },
  Mounts: [{ Type: "tmpfs" }],
});

test("recovery CLI refuses alternate resource arguments before accessing Docker", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/rehearse-code-recovery.mjs", "--production"],
    {
      encoding: "utf8",
      env: { PATH: "" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts no alternate resource targets/);
  assert.equal(result.stdout, "");
});

test("recovery harness accepts only disposable, no-network, read-only container isolation", () => {
  assert.doesNotThrow(() => verifyIsolation(isolated()));
  for (const patch of [
    { NetworkMode: "bridge" },
    { ReadonlyRootfs: false },
    { PortBindings: { "5432/tcp": [{ HostPort: "5432" }] } },
    { Binds: ["/private:/data"] },
  ]) {
    const info = isolated();
    Object.assign(info.HostConfig, patch);
    assert.throws(() => verifyIsolation(info), /isolation verification failed/);
  }
  const mounted = isolated();
  mounted.Mounts = [{ Type: "volume" }];
  assert.throws(() => verifyIsolation(mounted), /isolation verification failed/);
  const unrelated = isolated();
  unrelated.Config.Labels = {};
  assert.throws(() => verifyIsolation(unrelated), /isolation verification failed/);
});

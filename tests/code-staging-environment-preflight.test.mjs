import { test } from "node:test";
import assert from "node:assert/strict";
import { rootCertificates } from "node:tls";
import { inspectEnvironment } from "../scripts/staging-environment-preflight.mjs";

const config = {
  url: "postgres://user:password@shinkansen.proxy.rlwy.net:48734/railway",
  ca: rootCertificates[0],
};

function client(markerPresent, matches, options = {}) {
  const state = { closed: false, mode: "", calls: 0 };
  return {
    state,
    create: () => ({
      begin: async (mode, callback) => {
        state.mode = mode;
        return callback(async () => {
          state.calls++;
          if (options.fail) throw new Error("synthetic failure");
          if (state.calls === 1)
            return [{ database_matches: !options.wrongDatabase, marker_present: markerPresent }];
          return [{ matches }];
        });
      },
      end: async () => {
        state.closed = true;
      },
    }),
  };
}

test("reports absent, matching and conflicting markers under read-only isolation", async () => {
  for (const [present, matches, expected] of [
    [false, false, "absent"],
    [true, true, "matching"],
    [true, false, "conflicting"],
  ]) {
    const mock = client(present, matches);
    const result = await inspectEnvironment(config, mock.create);
    assert.equal(result.marker, expected);
    assert.equal(mock.state.mode, "isolation level repeatable read read only");
    assert.equal(mock.state.calls, present ? 2 : 1);
    assert.equal(mock.state.closed, true);
  }
});

test("mismatched target and failed reads fail closed and close the connection", async () => {
  const wrong = client(false, false, { wrongDatabase: true });
  await assert.rejects(inspectEnvironment(config, wrong.create), /database_mismatch/);
  assert.equal(wrong.state.closed, true);
  const failed = client(false, false, { fail: true });
  await assert.rejects(inspectEnvironment(config, failed.create), /synthetic failure/);
  assert.equal(failed.state.closed, true);
  let created = false;
  await assert.rejects(
    inspectEnvironment({ ...config, url: config.url.replace("48734", "48735") }, () => {
      created = true;
    }),
  );
  assert.equal(created, false);
});

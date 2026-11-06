import { test } from "node:test";
import assert from "node:assert/strict";
import { rootCertificates } from "node:tls";
import { inspectPrerequisites } from "../scripts/staging-prerequisite-diagnostics.mjs";

test("diagnostics use read-only transaction and close even on failure", async () => {
  const config = {
    url: "postgres://user:password@shinkansen.proxy.rlwy.net:48734/railway",
    ca: rootCertificates[0],
  };
  let closed = 0;
  let mode;
  const makeClient = () => ({
    begin: async (value, callback) => {
      mode = value;
      return callback(async () => [{ database_matches: true, auth_schema_exists: false }]);
    },
    end: async () => {
      closed++;
    },
  });
  const result = await inspectPrerequisites(config, makeClient);
  assert.equal(mode, "read only");
  assert.equal(result.auth_schema_exists, false);
  assert.equal(closed, 1);
  await assert.rejects(
    inspectPrerequisites(config, () => ({
      begin: async (_value, callback) =>
        callback(async () => {
          throw new Error("failure");
        }),
      end: async () => {
        closed++;
      },
    })),
    /failure/,
  );
  assert.equal(closed, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionOptions, inspectStaging } from "../scripts/staging-db-preflight.mjs";

const config = {
  url: "postgresql://test:synthetic@staging.example.test:1234/fixture",
  host: "staging.example.test",
  port: "1234",
  database: "fixture",
};

test("staging target and TLS options are fixed before connecting", () => {
  const options = connectionOptions(config.url, config.host, config.port, config.database);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, servername: config.host });
  assert.equal(options.host, config.host);
  assert.equal(options.port, 1234);
  for (const url of [
    "postgresql://test:synthetic@other.example.test:1234/fixture",
    "postgresql://test:synthetic@staging.example.test:1235/fixture",
    "postgresql://test:synthetic@staging.example.test:1234/other",
    `${config.url}?sslmode=disable`,
    `${config.url}#fragment`,
    "not-a-url",
  ]) {
    assert.throws(() => connectionOptions(url, config.host, config.port, config.database));
  }
});

test("preflight uses a read-only transaction and closes the client", async () => {
  let closed = false;
  let mode;
  const result = await inspectStaging(config, (options) => {
    assert.equal(options.ssl.rejectUnauthorized, true);
    return {
      begin: async (value, callback) => {
        mode = value;
        return callback(async () => [
          { database: "fixture", code_controls_present: false, code_cap_constraint_present: false },
        ]);
      },
      end: async () => {
        closed = true;
      },
    };
  });
  assert.equal(mode, "read only");
  assert.equal(result.code_controls_present, false);
  assert.equal(closed, true);
});

test("unexpected database closes the client without success", async () => {
  for (const rows of [[{ database: "other" }], []]) {
    let closed = false;
    await assert.rejects(
      inspectStaging(config, () => ({
        begin: async (_mode, callback) => callback(async () => rows),
        end: async () => {
          closed = true;
        },
      })),
      /identity did not match/,
    );
    assert.equal(closed, true);
  }
});

test("a query failure closes the client and a mismatched target never connects", async () => {
  let closed = false;
  await assert.rejects(
    inspectStaging(config, () => ({
      begin: async () => {
        throw new Error("synthetic failure");
      },
      end: async () => {
        closed = true;
      },
    })),
    /synthetic failure/,
  );
  assert.equal(closed, true);
  let connected = false;
  await assert.rejects(
    inspectStaging({ ...config, host: "wrong.example.test" }, () => {
      connected = true;
    }),
    /do not match/,
  );
  assert.equal(connected, false);
});

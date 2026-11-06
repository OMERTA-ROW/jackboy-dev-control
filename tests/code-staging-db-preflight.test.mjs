import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer, connect, checkServerIdentity } from "node:tls";
import {
  connectionOptions,
  failureCategory,
  inspectStaging,
} from "../scripts/staging-db-preflight.mjs";

const dir = mkdtempSync(join(tmpdir(), "staging-ca-test-"));
for (const name of ["trusted", "untrusted"]) {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=not-the-requested-host",
      "-keyout",
      join(dir, `${name}.key`),
      "-out",
      join(dir, `${name}.crt`),
    ],
    { stdio: "ignore" },
  );
}
after(() => rmSync(dir, { recursive: true, force: true }));
const ca = readFileSync(join(dir, "trusted.crt"), "utf8");

const config = {
  url: "postgresql://test:synthetic@staging.example.test:1234/fixture",
  host: "staging.example.test",
  port: "1234",
  database: "fixture",
  ca,
};

test("staging target and TLS options are fixed before connecting", () => {
  const options = connectionOptions(config.url, config.host, config.port, config.database, ca);
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.servername, config.host);
  assert.equal(options.ssl.ca, ca);
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
    assert.throws(() => connectionOptions(url, config.host, config.port, config.database, ca));
  }
  for (const invalid of [undefined, "", "invalid", ca + ca]) {
    assert.throws(
      () => connectionOptions(config.url, config.host, config.port, config.database, invalid),
      /invalid_ca_certificate/,
    );
  }
});

test("CA-only TLS accepts a trusted hostname mismatch and rejects another certificate", async () => {
  const server = createServer(
    {
      key: readFileSync(join(dir, "trusted.key")),
      cert: ca,
    },
    (socket) => socket.end(),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const options = connectionOptions(config.url, config.host, config.port, config.database, ca);
    const attempt = (ssl) =>
      new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port, ...ssl }, () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
    await attempt(options.ssl);
    await assert.rejects(
      attempt({ ...options.ssl, ca: readFileSync(join(dir, "untrusted.crt"), "utf8") }),
    );
    await assert.rejects(attempt({ ...options.ssl, checkServerIdentity }), /altname|hostname/i);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
      /database_mismatch/,
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
    /target_mismatch/,
  );
  assert.equal(connected, false);
});

test("failure categories never include raw error text or unrecognized codes", () => {
  const secret = "synthetic-private-value";
  for (const [code, category] of [
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_certificate"],
    ["28P01", "authentication"],
    ["ECONNREFUSED", "connection"],
    [secret, "unclassified"],
  ]) {
    assert.equal(failureCategory({ code, message: secret }), category);
  }
  assert.equal(failureCategory(new Error(secret)), "unclassified");
});

test("CLI prints only the safe failure category, not the supplied URL", () => {
  const secret = "synthetic-private-value";
  const result = spawnSync(process.execPath, ["scripts/staging-db-preflight.mjs"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      STAGING_DATABASE_URL: `postgresql://test:${secret}@other.example.test:1234/fixture`,
      STAGING_EXPECTED_HOST: config.host,
      STAGING_EXPECTED_PORT: config.port,
      STAGING_EXPECTED_DATABASE: config.database,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /target_mismatch/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { isOmniVerificationFresh, OMNI_VERIFICATION_MAX_AGE_MS } from "../src/lib/omni-link.ts";

const now = Date.parse("2026-11-02T12:00:00.000Z");
const valid = {
  verified: true,
  verified_at: new Date(now - 1_000).toISOString(),
  config_hash: "expected",
};

test("OMNI verification requires a recent record for the current configuration", () => {
  assert.equal(isOmniVerificationFresh(valid, "expected", now), true);
  assert.equal(isOmniVerificationFresh({ ...valid, verified_at: null }, "expected", now), false);
  assert.equal(
    isOmniVerificationFresh({ ...valid, verified_at: "invalid" }, "expected", now),
    false,
  );
  assert.equal(isOmniVerificationFresh({ ...valid, verified: false }, "expected", now), false);
  assert.equal(isOmniVerificationFresh(valid, "changed", now), false);
  assert.equal(
    isOmniVerificationFresh(
      { ...valid, verified_at: new Date(now - OMNI_VERIFICATION_MAX_AGE_MS - 1).toISOString() },
      "expected",
      now,
    ),
    false,
  );
  assert.equal(
    isOmniVerificationFresh(
      { ...valid, verified_at: new Date(now + 31_000).toISOString() },
      "expected",
      now,
    ),
    false,
  );
});

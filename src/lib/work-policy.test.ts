import { expect, it } from "vitest";
import { existingTestsPassed, isCreditError, standaloneTestTask } from "./work-policy";
it("suppresses standalone tests and fixtures, but permits a named feature blocker", () => {
  expect(standaloneTestTask("Add tests", ["tests/auth.test.ts"])).toBe(true);
  expect(standaloneTestTask("Fix test fixture", ["tests/fixture.json"])).toBe(true);
  expect(standaloneTestTask("Fix test fixture", ["tests/fixture.json"], "OMNI connection repair blocked by failing existing fixture")).toBe(false);
  expect(standaloneTestTask("Fix invitation acceptance", ["src/auth.ts", "tests/auth.test.ts"])).toBe(false);
});
it("requires completed passing existing checks before draft PR", () => {
  expect(existingTestsPassed([], 0)).toBe(false);
  expect(existingTestsPassed([{ status: "in_progress", conclusion: null }], 1)).toBe(false);
  expect(existingTestsPassed([{ status: "completed", conclusion: "failure" }], 1)).toBe(false);
  expect(existingTestsPassed([{ status: "completed", conclusion: "success" }], 1)).toBe(true);
});
it("only credit failures get the credit pause label", () => {
  expect(isCreditError({ status: 402 })).toBe(true);
  expect(isCreditError({ httpStatus: 402 })).toBe(true);
  expect(isCreditError({ status: 403, message: "organization permission missing" })).toBe(false);
});
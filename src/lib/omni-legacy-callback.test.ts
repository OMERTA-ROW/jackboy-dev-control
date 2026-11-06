import { expect, it } from "vitest";
import { rejectLegacyOmniCallback } from "@/routes/api/public/omni/callback";

it("refuses legacy result callbacks until scoped verification is implemented", async () => {
  const response = rejectLegacyOmniCallback();
  expect(response.status).toBe(410);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("scoped verification is not available");
});

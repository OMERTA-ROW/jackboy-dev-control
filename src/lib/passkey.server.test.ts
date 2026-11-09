import { beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from },
}));

import { issueGrant } from "./passkey.server";

describe("passkey grant audit", () => {
  beforeEach(() => from.mockReset());

  it("invalidates the newly issued grant when its audit record cannot be stored", async () => {
    const insertGrant = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: "grant-id", expires_at: "2030-01-01T00:00:00.000Z" },
        error: null,
      }),
    };
    const audit = {
      insert: vi.fn().mockResolvedValue({ error: new Error("audit unavailable") }),
    };
    const invalidateGrant = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "grant-id" },
        error: null,
      }),
    };
    const tableSequence = [insertGrant, audit, invalidateGrant];
    from.mockImplementation(() => tableSequence[from.mock.calls.length - 1]);

    await expect(issueGrant("owner-id", "production_deploy", "target", "credential-id"))
      .rejects.toThrow("the grant was invalidated");
    expect(from.mock.calls.map(([table]) => table)).toEqual([
      "step_up_grants",
      "audit_logs",
      "step_up_grants",
    ]);
    expect(invalidateGrant.update).toHaveBeenCalledWith({ used_at: expect.any(String) });
  });

  it("fails closed when grant invalidation cannot be confirmed", async () => {
    const insertGrant = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: "grant-id", expires_at: "2030-01-01T00:00:00.000Z" },
        error: null,
      }),
    };
    const invalidateGrant = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const tableSequence = [
      insertGrant,
      { insert: vi.fn().mockResolvedValue({ error: new Error("audit unavailable") }) },
      invalidateGrant,
    ];
    from.mockImplementation(() => tableSequence[from.mock.calls.length - 1]);

    await expect(issueGrant("owner-id", "production_deploy", "target", "credential-id"))
      .rejects.toThrow("invalidation could not be verified");
    expect(from.mock.calls.map(([table]) => table)).toEqual([
      "step_up_grants",
      "audit_logs",
      "step_up_grants",
    ]);
  });
});

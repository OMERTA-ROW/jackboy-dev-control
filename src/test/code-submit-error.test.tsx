import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-only", user: { id: "owner" } } },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
}));
import { useCodeTasks } from "@/components/CodeTasks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("rejects blocked CODE submissions instead of reporting success or automatically dispatching again", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { error: "Emergency Stop engaged; $10 cumulative limit reached" },
        { status: 403 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("sessionStorage", { getItem: () => "[]", setItem: vi.fn() });
  const { result } = renderHook(useCodeTasks);
  await act(async () => {
    await expect(result.current.submit("CODE Hercules Driver OS: fix footer")).rejects.toThrow(
      "Emergency Stop",
    );
  });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.error).toContain("$10 cumulative limit");
  expect(result.current.cards).toEqual([]);
  expect(fetch).toHaveBeenCalledOnce();
});

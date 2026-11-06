import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchOmniJobs } from "./omni-link.server";

const database = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: database }));

describe("legacy OMNI dispatch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("does not send or modify queued jobs even when credentials are configured", async () => {
    vi.stubEnv("OMNI_API_URL", "https://omni.example");
    vi.stubEnv("OMNI_API_KEY", "example-key");
    vi.stubEnv("OMNI_CALLBACK_SECRET", "example-secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(dispatchOmniJobs()).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped:
        "Legacy OMNI dispatch is disabled until job-scoped owner authorization is available.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(database.from).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dashboardFetch } = vi.hoisted(() => ({
  dashboardFetch: vi.fn(async () => new Response("dashboard", { status: 200 })),
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: dashboardFetch },
}));
vi.mock("./lib/live-relay.server", () => ({ handleLiveRequest: vi.fn() }));
vi.mock("./lib/error-capture", () => ({ consumeLastCapturedError: vi.fn() }));
vi.mock("./lib/error-page", () => ({ renderErrorPage: () => "error" }));

import server from "./server";

describe("dashboard routing with misplaced runner flags", () => {
  beforeEach(() => {
    dashboardFetch.mockClear();
    vi.stubEnv("OMNI_LINK_RUNNER_MODE", "true");
    vi.stubEnv("OMNI_LINK_NODE_RUNNER_ENABLED", "true");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("OMNI_LINK_REMOTE_RUNNER_URL", "");
    vi.stubEnv("OMNI_LINK_REMOTE_RUNNER_ENABLED", "");
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "");
    vi.stubEnv("OMNI_LINK_REMOTE_RUNNER_SECRET", "r".repeat(40));
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    "https://jackboy-dev-control.lovable.app/",
    "https://jackboy-dev-control.lovable.app/settings",
    "https://id-preview--abc.lovable.app/",
    "https://id-preview--abc.lovable.app/settings",
    "https://abc.lovableproject.com/settings",
  ])("routes %s to the dashboard instead of runner-only 404", async (url) => {
    const response = await server.fetch(new Request(url), {}, {});
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dashboard");
    expect(dashboardFetch).toHaveBeenCalledOnce();
  });

  it("keeps a dedicated Railway runner from serving dashboard pages", async () => {
    const response = await server.fetch(
      new Request("https://jackboy-runner.up.railway.app/settings"), {}, {},
    );
    expect(response.status).toBe(404);
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1:8080", "https://runner.up.railway.app"])(
    "returns JSON method rejection, not dashboard HTML, at %s",
    async (origin) => {
      vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "test-environment");
      const response = await server.fetch(
        new Request(`${origin}/api/public/omni/runner`), {}, {},
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("allow")).toBe("POST");
      expect(dashboardFetch).not.toHaveBeenCalled();
    },
  );

  it("keeps Railway loopback dashboard pages closed", async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "test-environment");
    const response = await server.fetch(new Request("http://127.0.0.1:8080/"), {}, {});
    expect(response.status).toBe(404);
    expect(dashboardFetch).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appAccess = vi.hoisted(() => ({
  value: {
    canWrite: true,
    canCreatePullRequests: true,
    permissions: { contents: "write", pull_requests: "write" },
  },
}));

vi.mock("./github-app.server", () => ({
  githubTokenFor: vi.fn(async () => ({ token: "test-installation-token", via: "app" })),
  refreshGithubTokenFor: vi.fn(async () => ({ token: "refreshed-installation-token", via: "app" })),
  appAccessFor: vi.fn(async () => appAccess.value),
  repoFromPath: vi.fn(() => "OMERTA-ROW/Omni"),
}));

import { openDraftPr, write } from "./repo-workspace.server";

describe("repository workspace draft PR permissions", () => {
  const repo = { owner: "OMERTA-ROW", repo: "Omni", base: "main", full: "OMERTA-ROW/Omni" };
  const branch = "jackboy/pr-permission-regression";
  let requests: { method: string; path: string }[];
  let deniedPullRequests: number;

  beforeEach(() => {
    requests = [];
    deniedPullRequests = 0;
    appAccess.value = {
      canWrite: true,
      canCreatePullRequests: true,
      permissions: { contents: "write", pull_requests: "write" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ method, path: url.pathname });

        if (url.pathname.endsWith(`/git/ref/heads/${branch}`) && method === "GET") {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        if (url.pathname.endsWith("/git/ref/heads/main") && method === "GET") {
          return Response.json({ object: { sha: "a".repeat(40) } });
        }
        if (url.pathname.endsWith("/git/refs") && method === "POST") {
          return Response.json({ ref: `refs/heads/${branch}` }, { status: 201 });
        }
        if (url.pathname.endsWith(`/contents/src/fix.ts`) && method === "GET") {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        if (url.pathname.endsWith(`/contents/src/fix.ts`) && method === "PUT") {
          return Response.json({ commit: { sha: "b".repeat(40) } }, { status: 201 });
        }
        if (url.pathname.endsWith("/pulls") && method === "GET") {
          return Response.json([]);
        }
        if (url.pathname.endsWith("/pulls") && method === "POST" && deniedPullRequests > 0) {
          deniedPullRequests--;
          return Response.json(
            { message: "Resource not accessible by integration" },
            { status: 403 },
          );
        }
        if (url.pathname.endsWith("/pulls") && method === "POST") {
          return Response.json(
            { number: 12, html_url: "https://github.com/OMERTA-ROW/Omni/pull/12" },
            { status: 201 },
          );
        }
        throw new Error(`Unexpected mocked GitHub request: ${method} ${url.pathname}`);
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("preserves a successfully pushed branch and reports PR permission denial precisely", async () => {
    const pushed = await write(
      repo,
      branch,
      "src/fix.ts",
      "export const fixed = true;\n",
      "Fix task",
    );
    expect(pushed.action).toBe("created");
    expect(
      requests.some(
        (request) => request.method === "PUT" && request.path.endsWith("/contents/src/fix.ts"),
      ),
    ).toBe(true);

    deniedPullRequests = 2;
    await expect(openDraftPr(repo, branch, "Fix task", "Tested change")).rejects.toThrow(
      `Draft PR refused: GitHub denied Pull requests: write on ${repo.full}. Branch ${branch} was already pushed and remains unchanged.`,
    );
    expect(
      requests.some((request) => request.method === "POST" && request.path.endsWith("/git/refs")),
    ).toBe(true);
    expect(
      requests.some((request) => request.method === "POST" && request.path.endsWith("/pulls")),
    ).toBe(true);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("blocks draft PR creation when the recorded App grant lacks Pull requests: write", async () => {
    await write(repo, branch, "src/fix.ts", "export const fixed = true;\n", "Fix task");
    appAccess.value = {
      canWrite: true,
      canCreatePullRequests: false,
      permissions: { contents: "write", pull_requests: "read" },
    };

    await expect(openDraftPr(repo, branch, "Fix task", "Tested change")).rejects.toThrow(
      `GitHub App installation lacks Pull requests: write on ${repo.full}`,
    );
    expect(
      requests.some((request) => request.method === "POST" && request.path.endsWith("/pulls")),
    ).toBe(false);
  });

  it("refreshes a stale installation token once and opens a draft PR", async () => {
    deniedPullRequests = 1;
    const result = await openDraftPr(repo, branch, "Fix task", "Tested change");
    const pullRequestPosts = requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/pulls"),
    );

    expect(result).toEqual({
      number: 12,
      url: "https://github.com/OMERTA-ROW/Omni/pull/12",
      existed: false,
    });
    expect(pullRequestPosts).toHaveLength(2);
    expect(
      JSON.parse((vi.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit).body as string).draft,
    ).toBe(true);
    expect(
      requests.some((request) => request.method === "POST" && request.path.endsWith("/git/refs")),
    ).toBe(false);
  });

  it("returns an existing draft PR without requiring another write grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/pulls")) {
          return Response.json([
            { number: 7, html_url: "https://github.com/OMERTA-ROW/Omni/pull/7" },
          ]);
        }
        throw new Error(`Unexpected mocked GitHub request: ${url.pathname}`);
      }),
    );
    appAccess.value = {
      canWrite: true,
      canCreatePullRequests: false,
      permissions: { contents: "write", pull_requests: "read" },
    };

    await expect(openDraftPr(repo, branch, "Fix task", "Tested change")).resolves.toMatchObject({
      number: 7,
      existed: true,
    });
  });
});

import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";
import { MAIN_NAV } from "@/lib/project-hub";
import { ADVANCED } from "@/routes/_authenticated/settings";

const router = () => createRouter({ routeTree, context: { queryClient: new QueryClient() } });
const leaf = (path: string) => router().matchRoutes(path).at(-1)?.routeId;

// Match routes without running loaders or rendering.
describe("App routing", () => {
  it("matches a page for / instead of falling back to not found", () => {
    expect(leaf("/")).not.toBe(rootRouteId);
  });
  it("every main menu entry has a real page", () => {
    for (const p of MAIN_NAV) expect(leaf(p), p).not.toBe(rootRouteId);
  });
  it("main menu stays small", () => expect(MAIN_NAV.length).toBeLessThanOrEqual(6));
  it("project detail opens by id", () => expect(leaf("/project/0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("/_authenticated/project/$id"));
  it("every advanced tool is still reachable from Settings", () => {
    const all = ADVANCED.flatMap((g) => g.items.map((i) => i.to));
    for (const p of ["/autopilot", "/releases", "/agents", "/omni", "/jax", "/razul", "/activity", "/integrations", "/access", "/overview"]) expect(all).toContain(p);
    for (const p of all) expect(leaf(p), p).not.toBe(rootRouteId);
  });
});

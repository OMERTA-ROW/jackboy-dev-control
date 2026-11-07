import { describe, expect, it } from "vitest";
import { actionArea, actorLabel, detailLine } from "./audit-attribution";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("audit attribution", () => {
  it("names the signed-in person as You with their role", () => {
    expect(actorLabel({ actor: ME, actor_role: "owner", actor_email: "me@x.com" }, ME)).toBe("You (owner)");
  });

  it("shows another person's email and role when visible", () => {
    expect(actorLabel({ actor: OTHER, actor_role: "admin", actor_email: "a@x.com" }, ME)).toBe("a@x.com (admin)");
  });

  it("keeps entries from people who lost access, marked as former member", () => {
    expect(actorLabel({ actor: OTHER, actor_role: null, actor_email: null }, ME)).toBe("Former member · 22222222");
  });

  it("labels actions with no person as System", () => {
    expect(actorLabel({ actor: null, actor_role: null, actor_email: null }, ME)).toBe("System (no signed-in person)");
  });

  it("never hides unknown action codes", () => {
    expect(actionArea("stepup.granted")).toBe("Passkey confirmed");
    expect(actionArea("weird.thing")).toBe("weird.thing");
  });

  it("trims long details", () => {
    expect(detailLine({ a: "x".repeat(500) }, 20)).toHaveLength(20);
  });
});

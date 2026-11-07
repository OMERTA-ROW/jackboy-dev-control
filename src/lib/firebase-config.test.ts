import { describe, expect, it } from "vitest";
import { diagnoseFirebase, FIREBASE_PUBLIC } from "./firebase-config";

describe("Firebase config", () => {
  it("targets project jackboy-b6bb5", () => {
    expect(FIREBASE_PUBLIC.projectId).toBe("jackboy-b6bb5");
    expect(FIREBASE_PUBLIC.messagingSenderId).toBe(FIREBASE_PUBLIC.appId.split(":")[1]);
  });
  it("checks key shapes and trims stray spaces", () => {
    const key = `AIza${"a".repeat(35)}`, vapid = `B${"x".repeat(86)}`;
    expect(diagnoseFirebase(` ${key} `, vapid, true)).toEqual({ apiKey: "ok", vapidKey: "ok", serverSender: true });
    expect(diagnoseFirebase(undefined, "", false)).toEqual({ apiKey: "missing", vapidKey: "missing", serverSender: false });
    expect(diagnoseFirebase("sk-123", "nope", false)).toMatchObject({ apiKey: "malformed", vapidKey: "malformed" });
  });
});

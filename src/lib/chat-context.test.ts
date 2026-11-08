import { describe, expect, it } from "vitest";
import { authorLabel, contextInstructions, JACKBOY_BRIEF, observerLabel, parseContextKey, slugFor, storedNotes, VISUAL_POLICY, type ContextBrief } from "./chat-context";

const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
const brief = (over: Partial<ContextBrief> = {}): ContextBrief => ({ key: `agent:${id}`, name: "OMNI", role: "Build and test engine", kind: "agent", notes: [], work: [], projectId: null, projectName: null, hasRepo: false, ...over });

describe("context keys", () => {
  it("accepts Jackboy, agent and project keys and rejects anything else", () => {
    expect(parseContextKey("jackboy")).toEqual({ type: "jackboy" });
    expect(parseContextKey(undefined)).toEqual({ type: "jackboy" });
    expect(parseContextKey(`agent:${id}`)).toEqual({ type: "agent", id });
    expect(parseContextKey(`project:${id}`)).toEqual({ type: "project", id });
    expect(parseContextKey("agent:not-a-uuid")).toBeNull();
    expect(parseContextKey("vault:" + id)).toBeNull();
    expect(parseContextKey(42)).toBeNull();
  });
});

describe("context pivots use stored notes only", () => {
  it("Jackboy's own context adds no extra instructions", () => {
    expect(contextInstructions(JACKBOY_BRIEF)).toBe("");
  });
  it("with no stored notes, tells the model to say so instead of guessing", () => {
    const text = contextInstructions(brief());
    expect(text).toContain("none stored yet");
    expect(text).toContain("Never invent facts");
    expect(text).toContain("never claim OMNI is connected");
  });
  it("includes stored notes verbatim with their date", () => {
    const text = contextInstructions(brief({ notes: storedNotes([{ label: "Owner notes about OMNI", text: "Runs on Railway.", updatedAt: "2026-11-07T10:00:00Z" }]) }));
    expect(text).toContain("Owner notes about OMNI (updated 2026-11-07): Runs on Railway.");
    expect(text).not.toContain("none stored yet");
  });
  it("blank notes never count as facts", () => {
    expect(storedNotes([{ label: "a", text: "   " }, { label: "b", text: null }])).toEqual([]);
  });
  it("caps very long notes instead of sending everything", () => {
    const long = "x".repeat(5000);
    const text = contextInstructions(brief({ notes: storedNotes([{ label: "a", text: long }, { label: "b", text: long }]) }));
    expect(text).toContain("not all included");
  });
});

describe("visual descriptions are observational", () => {
  it("every visual answer forbids diagnoses and marks unclear motion uncertain", () => {
    expect(VISUAL_POLICY).toMatch(/never medical/);
    expect(VISUAL_POLICY).toContain("'Uncertain:'");
  });
  it("Iggy (visual observer) gets the observation-only rule", () => {
    const text = contextInstructions(brief({ name: "Iggy", role: "Visual observer", kind: "visual_observer" }));
    expect(text).toContain("observational note only, not a diagnosis");
    expect(text).toContain("'Uncertain:'");
  });
  it("shows a fixed label under visual replies, stronger for observers", () => {
    expect(observerLabel("visual_observer", true)).toBe("Observation only, not a medical diagnosis. Movement between frames is uncertain.");
    expect(observerLabel("agent", true)).toContain("uncertain");
    expect(observerLabel("visual_observer", false)).toBeNull();
  });
});

describe("identity labels", () => {
  it("names the speaker and the notes used", () => {
    expect(authorLabel("user", {}, "owner")).toBe("You · Owner");
    expect(authorLabel("assistant", { contextName: "OMNI" }, "owner")).toBe("Jackboy · OMNI notes");
    expect(authorLabel("assistant", { contextName: "Jackboy" }, "owner")).toBe("Jackboy");
    expect(authorLabel("user", { voice: true }, "owner")).toBe("You · Owner · voice");
  });
  it("makes safe slugs", () => {
    expect(slugFor("Iggy Cam #2")).toBe("iggy-cam-2");
    expect(slugFor("!")).toMatch(/^agent-/);
  });
});

import { it, expect } from "vitest";
import { safeEvidenceUrl } from "./chat-action";
it("rejects untrusted or deceptive evidence links", () => {
  expect(safeEvidenceUrl("https://github.com/OMERTA-ROW/Omni/pull/1")).toBe(true);
  expect(safeEvidenceUrl("https://github.com.evil.example/OMERTA-ROW/Omni")).toBe(false);
  expect(safeEvidenceUrl("https://token@github.com/OMERTA-ROW/Omni")).toBe(false);
  expect(safeEvidenceUrl("javascript:alert(1)")).toBe(false);
  expect(safeEvidenceUrl("//evil.example")).toBe(false);
  expect(safeEvidenceUrl("/foundry")).toBe(true);
});
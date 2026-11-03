import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-text";
describe("htmlToText", () => {
  it("removes script blocks with odd closing tags", () => {
    expect(htmlToText("a<script>x()</script >b<script>y()</script foo>c")).toBe("a b c");
  });
  it("cannot be tricked by nested tags", () => {
    expect(htmlToText("<scr<script>ipt>alert(1)</script>")).not.toMatch(/[<>]/);
  });
  it("does not turn encoded entities back into tags", () => {
    expect(htmlToText("&lt;img src=x onerror=1&gt;hi")).not.toMatch(/[<>]/);
  });
});

import { describe, expect, it } from "vitest";
import { analyzeHtml, detectDemo, findingKey } from "./autopilot";

const page = (body: string) => `<html lang="en"><head><title>x</title><meta name="viewport" content="w"></head><body>${body}</body></html>`;

describe("demo detection", () => {
  it("flags a visible demo mode banner", () => {
    const f = detectDemo(page('<div class="banner">Demo mode — data resets nightly</div>'), "https://a.test/");
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("demo");
    expect(f[0]!.message).toContain("Demo mode");
  });
  it("flags simulated, lorem ipsum and try-demo buttons", () => {
    const kinds = detectDemo(page("<p>Simulated revenue</p><p>Lorem ipsum dolor</p><button>Try the demo</button>"), "u").map((x) => x.message.split(":")[0]);
    expect(kinds).toEqual(["“Simulated” label", "Lorem ipsum placeholder text", "Demo-only button or link"]);
  });
  it("ignores words hidden in scripts, styles and comments", () => {
    expect(detectDemo(page('<script>const demoMode="demo mode"</script><style>.mock{}</style><!-- lorem ipsum -->Real app'), "u")).toEqual([]);
  });
  it("does not flag a normal page", () => expect(detectDemo(page("<h1>Book a table</h1><button>Reserve</button>"), "u")).toEqual([]));
  it("analyzeHtml includes demo findings", () => expect(analyzeHtml(page("Sample data shown"), "u").some((x) => x.kind === "demo")).toBe(true));
  it("finding keys stay stable when the quoted snippet changes", () => {
    const a = { kind: "demo", url: "u", message: "“Demo mode” label: “…a…”" };
    const b = { kind: "demo", url: "u", message: "“Demo mode” label: “…b…”" };
    expect(findingKey(a)).toBe(findingKey(b));
  });
});

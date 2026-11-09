import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { ACCEPTANCE_FILE, acceptancePatchCheck } from "./code-acceptance";
import { acceptancePublishGate } from "./code-acceptance.server";
import { crc32, readZipEntry } from "./zip-read";

const F = ACCEPTANCE_FILE;
const goodNew = [
  `diff --git a/${F} b/${F}`,
  "new file mode 100644",
  "index 0000000..1b2c3d4",
  "--- /dev/null",
  `+++ b/${F}`,
  "@@ -0,0 +1 @@",
  "+Acceptance test 2026-11-09",
  "",
].join("\n");
const goodAppend = [
  `diff --git a/${F} b/${F}`,
  "index 1a2b3c4..5d6e7f8 100644",
  `--- a/${F}`,
  `+++ b/${F}`,
  "@@ -1 +1,2 @@",
  " Acceptance test 2026-11-08",
  "+Acceptance test 2026-11-09",
  "",
].join("\n");

/** Builds a real single-entry ZIP (deflate or stored) like upload-artifact produces. */
function zipOf(name: string, text: string, method: 0 | 8 = 8, nameOverride?: string[]): Uint8Array {
  const names = nameOverride ?? [name];
  const data = new TextEncoder().encode(text);
  const comp = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
  const crc = crc32(data);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const n of names) {
    const nb = new TextEncoder().encode(n);
    const local = new Uint8Array(30 + nb.length + comp.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nb.length, true);
    local.set(nb, 30);
    local.set(comp, 30 + nb.length);
    const central = new Uint8Array(46 + nb.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    central.set(nb, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((t, c) => t + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, names.length, true);
  ev.setUint16(10, names.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const p of [...locals, ...centrals, eocd]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("acceptance patch check (before the draft PR opens)", () => {
  it("allows only a dated line added to the acceptance file", () => {
    expect(acceptancePatchCheck(goodNew)).toEqual({ ok: true, reasons: [] });
    expect(acceptancePatchCheck(goodAppend).ok).toBe(true);
  });
  it("refuses any other file, even alongside the allowed one", () => {
    const other =
      goodNew +
      [
        "diff --git a/src/x.ts b/src/x.ts",
        "--- a/src/x.ts",
        "+++ b/src/x.ts",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
        "",
      ].join("\n");
    const r = acceptancePatchCheck(other);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/src\/x\.ts/);
  });
  it("refuses deleted or rewritten lines", () => {
    expect(
      acceptancePatchCheck(
        goodAppend.replace(" Acceptance test 2026-11-08", "-Acceptance test 2026-11-08"),
      ).ok,
    ).toBe(false);
  });
  it("refuses deletes, renames, mode changes, symlinks and binary patches", () => {
    for (const header of [
      "deleted file mode 100644",
      "rename from docs/a.md",
      "old mode 100644",
      "new file mode 120000",
      "new file mode 100755",
      "GIT binary patch",
    ]) {
      expect(acceptancePatchCheck(goodNew.replace("new file mode 100644", header)).ok).toBe(false);
    }
  });
  it("refuses quoted or look-alike paths", () => {
    expect(
      acceptancePatchCheck(
        goodNew.replace(`diff --git a/${F} b/${F}`, `diff --git "a/${F}" "b/${F}"`),
      ).ok,
    ).toBe(false);
    expect(
      acceptancePatchCheck(goodNew.replace(`+++ b/${F}`, "+++ b/docs/CODE-ACCEPTANCE.md.bak")).ok,
    ).toBe(false);
  });
  it("refuses empty, oversized, undated or too-long changes", () => {
    expect(acceptancePatchCheck("").ok).toBe(false);
    expect(acceptancePatchCheck("x".repeat(70_000)).ok).toBe(false);
    expect(acceptancePatchCheck(goodNew.replace("+Acceptance test 2026-11-09", "+hello")).ok).toBe(
      false,
    );
    const many = goodNew.replace(
      "+Acceptance test 2026-11-09\n",
      "+Acceptance test 2026-11-09\n" + "+x\n".repeat(5),
    );
    expect(acceptancePatchCheck(many).ok).toBe(false);
  });
});

describe("bounded ZIP reader", () => {
  it("reads deflated and stored entries", async () => {
    for (const m of [0, 8] as const) {
      const bytes = await readZipEntry(zipOf("code.patch", goodNew, m), "code.patch", 65536);
      expect(new TextDecoder().decode(bytes)).toBe(goodNew);
    }
  });
  it("fails closed on missing, duplicate, oversized or corrupted entries", async () => {
    await expect(readZipEntry(zipOf("report.md", "x"), "code.patch", 65536)).rejects.toThrow();
    await expect(
      readZipEntry(
        zipOf("code.patch", goodNew, 8, ["code.patch", "code.patch"]),
        "code.patch",
        65536,
      ),
    ).rejects.toThrow();
    await expect(readZipEntry(zipOf("code.patch", goodNew), "code.patch", 10)).rejects.toThrow();
    const bad = zipOf("code.patch", goodNew, 0);
    bad[40] = bad[40]! ^ 0xff;
    await expect(readZipEntry(bad, "code.patch", 65536)).rejects.toThrow(/integrity/);
    await expect(readZipEntry(new Uint8Array(10), "code.patch", 65536)).rejects.toThrow();
  });
});

describe("publish gate downloads the run's own patch and fails closed", () => {
  const repo = "OMERTA-ROW/jackboy-dev-control";
  const fakeGithub = (zip: Uint8Array, artifacts?: unknown[]) =>
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/actions/runs/77/artifacts")) {
        return Response.json({
          artifacts: artifacts ?? [
            {
              id: 9,
              name: "code-evidence-1",
              size_in_bytes: zip.length,
              expired: false,
              workflow_run: { id: 77 },
            },
          ],
        });
      }
      if (u.endsWith("/actions/artifacts/9/zip"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://blob.example/signed?sig=1" },
        });
      if (u.startsWith("https://blob.example/")) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return new Response(zip as BodyInit);
      }
      return new Response("no", { status: 404 });
    });

  it("passes a clean docs-only patch", async () => {
    const f = fakeGithub(zipOf("code.patch", goodNew));
    expect(await acceptancePublishGate(repo, 77, 1, "t", f as unknown as typeof fetch)).toEqual({
      ok: true,
      reasons: [],
    });
  });
  it("blocks a patch touching another file", async () => {
    const bad = goodNew.replaceAll(F, "src/lib/code.server.ts");
    const r = await acceptancePublishGate(
      repo,
      77,
      1,
      "t",
      fakeGithub(zipOf("code.patch", bad)) as unknown as typeof fetch,
    );
    expect(r.ok).toBe(false);
  });
  it("blocks when the credential, evidence or download is missing", async () => {
    const zip = zipOf("code.patch", goodNew);
    expect(
      (
        await acceptancePublishGate(
          repo,
          77,
          1,
          undefined,
          fakeGithub(zip) as unknown as typeof fetch,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await acceptancePublishGate(
          repo,
          77,
          1,
          "t",
          fakeGithub(zip, []) as unknown as typeof fetch,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await acceptancePublishGate(repo, 77, 2, "t", fakeGithub(zip) as unknown as typeof fetch))
        .ok,
    ).toBe(false);
    const otherRun = [
      {
        id: 9,
        name: "code-evidence-1",
        size_in_bytes: zip.length,
        expired: false,
        workflow_run: { id: 78 },
      },
    ];
    expect(
      (
        await acceptancePublishGate(
          repo,
          77,
          1,
          "t",
          fakeGithub(zip, otherRun) as unknown as typeof fetch,
        )
      ).ok,
    ).toBe(false);
    const broken = vi.fn(async () => {
      throw new Error("network");
    });
    expect(
      (await acceptancePublishGate(repo, 77, 1, "t", broken as unknown as typeof fetch)).ok,
    ).toBe(false);
  });
});

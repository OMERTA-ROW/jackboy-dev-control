import { describe, expect, it } from "vitest";
import { attachmentNote, attachmentPath, frameName, frameTimes, inlineTurns, LIMITS, ownedPath, parseFrameName, pathFromStoreUrl, safeFileName, storeUrl, validateAttachment } from "./chat-attachments";

const me = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

describe("attachment checks", () => {
  it("accepts images, short videos and text files within limits", () => {
    expect(validateAttachment({ name: "a.png", type: "image/png", size: 1000 })).toEqual({ ok: true, kind: "image" });
    expect(validateAttachment({ name: "clip.mp4", type: "video/mp4", size: 1000 })).toEqual({ ok: true, kind: "video" });
    expect(validateAttachment({ name: "notes.md", type: "", size: 10 })).toEqual({ ok: true, kind: "text" });
  });
  it("rejects other types, empty files and oversize files", () => {
    expect(validateAttachment({ name: "x.exe", type: "application/x-msdownload", size: 10 }).ok).toBe(false);
    expect(validateAttachment({ name: "a.pdf", type: "application/pdf", size: 10 }).ok).toBe(false);
    expect(validateAttachment({ name: "a.png", type: "image/png", size: 0 }).ok).toBe(false);
    expect(validateAttachment({ name: "a.png", type: "image/png", size: LIMITS.image + 1 }).ok).toBe(false);
    expect(validateAttachment({ name: "v.mp4", type: "video/mp4", size: 50 * 1024 * 1024 + 1 }).ok).toBe(false);
  });
});

describe("private storage scope", () => {
  it("builds paths inside the owner's folder with a safe name", () => {
    const p = attachmentPath(me, "t1", "id1", "../../My Photo (1).png");
    expect(p.startsWith(`${me}/t1/id1-`)).toBe(true);
    expect(p).not.toContain("..");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
  });
  it("only the owner's own folder is usable", () => {
    expect(ownedPath(`${me}/t/a.png`, me)).toBe(true);
    expect(ownedPath(`${other}/t/a.png`, me)).toBe(false);
    expect(ownedPath(`${me}/../${other}/a.png`, me)).toBe(false);
    expect(ownedPath(`/${me}/a.png`, me)).toBe(false);
    expect(ownedPath("https://example.com/a.png", me)).toBe(false);
  });
  it("round-trips store references and ignores public links", () => {
    expect(pathFromStoreUrl(storeUrl(`${me}/t/a.png`))).toBe(`${me}/t/a.png`);
    expect(pathFromStoreUrl("https://x.test/a.png")).toBeNull();
  });
});

describe("video frames", () => {
  it("samples up to six evenly spaced frames, never the last instant", () => {
    expect(frameTimes(12)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(frameTimes(1)).toEqual([0.3, 0.8]);
    expect(frameTimes(NaN)).toEqual([0]);
    expect(Math.max(...frameTimes(600))).toBeLessThan(600);
  });
  it("labels each frame with its time and says motion between frames was not seen", () => {
    const name = frameName("dog.mp4", 2.5);
    expect(parseFrameName(name)).toEqual({ video: "dog.mp4", t: 2.5 });
    expect(attachmentNote({ filename: name, mediaType: "image/jpeg" })).toContain("Motion between frames was not seen");
    expect(attachmentNote({ filename: "dog.mp4", mediaType: "video/mp4" })).toContain("sampled still frames");
  });
  it("re-sends attachments from the latest two owner turns only", () => {
    const msgs = [{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }, { role: "user" }];
    expect([...inlineTurns(msgs)].sort()).toEqual([2, 4]);
  });
});

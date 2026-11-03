import { describe, expect, it } from "vitest";
import { approvalBlocker } from "./repository-resync";
import { isSafeSiteUrl, repoNameToDisplay } from "./project-resync";
import { projectStatus } from "./project-hub";

const p = { id: "1", name: "X", site_url: "https://x.app", lovable_url: null, github_repo: "o/x" };
describe("sync fixes", () => {
  it("approve explains why it can't run", () => {
    expect(approvalBlocker({ changes: 0, busy: false, invalidated: false, approved: false })).toMatch(/Nothing to approve/);
    expect(approvalBlocker({ changes: 2, busy: false, invalidated: true, approved: false })).toMatch(/Resync/);
    expect(approvalBlocker({ changes: 2, busy: false, invalidated: false, approved: false })).toBeNull();
  });
  it("linked repo shows no sync warning; gone repo is flagged", () => {
    expect(projectStatus({ ...p, repo_sync_status: "linked" }, undefined).label).toBe("Not scanned yet");
    expect(projectStatus({ ...p, repo_sync_status: "deleted" }, undefined).label).toBe("Repo gone");
  });
  it("only public https sites are detected", () => {
    expect(isSafeSiteUrl("https://a.lovable.app")).toBe(true);
    expect(isSafeSiteUrl("http://a.app")).toBe(false);
    expect(isSafeSiteUrl("https://localhost")).toBe(false);
  });
  it("repo name becomes a readable name", () => expect(repoNameToDisplay("orbiting-minds-mothership")).toBe("Orbiting Minds Mothership"));
});

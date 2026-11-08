export type DispatchPayload = {
  ownerId: string;
  projectId: string;
  grantId: string;
  jobId: string;
  repo: string;
  /** Wire kind (`build` for Jackboy `code` jobs). Test digests are unchanged from v2. */
  kind: "build" | "test";
  instructions: string;
};

export async function dispatchPayloadDigest(payload: DispatchPayload): Promise<string> {
  const body = JSON.stringify({
    contract: "jackboy.dispatch-payload/v2",
    ownerId: payload.ownerId,
    projectId: payload.projectId,
    grantId: payload.grantId,
    jobId: payload.jobId,
    repo: payload.repo,
    kind: payload.kind,
    instructions: payload.instructions,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

import { acceptancePatchCheck, ACCEPTANCE_MAX_PATCH_BYTES } from "./code-acceptance";
import { readZipEntry } from "./zip-read";

/** Largest evidence archive Jackboy will download for the publish gate. */
export const ACCEPTANCE_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

type Fetch = typeof fetch;
type Artifact = { id: number; name: string; size_in_bytes: number; expired: boolean; workflow_run?: { id?: number } };

/** Reads the exact patch artifact the publish job will apply (prepare uploads `code-evidence-<attempt>`,
 * immutable and unique per run) and checks it. Any read error fails closed: ok=false. */
export async function acceptancePublishGate(
  repo: string,
  runId: number,
  runAttempt: number,
  token: string | undefined,
  fetchImpl: Fetch = fetch,
): Promise<{ ok: boolean; reasons: string[] }> {
  const fail = (reason: string) => ({ ok: false, reasons: [reason] });
  if (!token) return fail("Jackboy can't read the patch: the GitHub credential is missing.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(runAttempt) || runAttempt <= 0)
    return fail("The run identity is invalid.");
  const headers = new Headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy" });
  headers.set("Authorization", ["Bearer", token].join(" "));
  const name = `code-evidence-${runAttempt}`;
  try {
    const list = await fetchImpl(
      `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=10`,
      { headers, redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!list.ok) return fail("Jackboy couldn't list the run's evidence.");
    const artifacts = ((await list.json()) as { artifacts?: Artifact[] }).artifacts ?? [];
    const matches = artifacts.filter((a) => a.name === name);
    if (matches.length !== 1) return fail(`Expected exactly one ${name} evidence file, found ${matches.length}.`);
    const art = matches[0]!;
    if (art.expired) return fail("The patch evidence has expired.");
    if (art.workflow_run?.id !== runId) return fail("The patch evidence belongs to a different run.");
    if (!(art.size_in_bytes > 0) || art.size_in_bytes > ACCEPTANCE_MAX_ARTIFACT_BYTES) return fail("The patch evidence is empty or too large.");
    const redirect = await fetchImpl(`https://api.github.com/repos/${repo}/actions/artifacts/${art.id}/zip`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const location = redirect.headers.get("location");
    if (redirect.status !== 302 || !location) return fail("GitHub didn't provide the patch download.");
    const url = new URL(location);
    if (url.protocol !== "https:" || url.username || url.password) return fail("GitHub returned an unsafe download address.");
    // Signed download URL: never forward the GitHub credential to it.
    const download = await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!download.ok) return fail("Jackboy couldn't download the patch evidence.");
    const declared = Number(download.headers.get("content-length") ?? "0");
    if (declared > ACCEPTANCE_MAX_ARTIFACT_BYTES) return fail("The patch evidence is too large.");
    const zip = new Uint8Array(await download.arrayBuffer());
    if (zip.length > ACCEPTANCE_MAX_ARTIFACT_BYTES) return fail("The patch evidence is too large.");
    const bytes = await readZipEntry(zip, "code.patch", ACCEPTANCE_MAX_PATCH_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return acceptancePatchCheck(text);
  } catch {
    return fail("Jackboy couldn't read or verify the patch, so publishing is refused.");
  }
}

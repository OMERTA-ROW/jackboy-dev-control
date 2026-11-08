export function createCodeGithubHeaders(token: string): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Jackboy",
    "Content-Type": "application/json",
  });
  headers.set("Authorization", ["Bearer", token].join(" "));
  return headers;
}

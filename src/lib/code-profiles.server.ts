// Server-only: the exact bytes of each approved CODE workflow version and its helper scripts.
// The workflow blob SHA computed here is the pin; changing any of these files changes what onboarding proposes.
import webWorkflow from "./code-profiles/web.code.yml?raw";
import goWorkflow from "./code-profiles/go.code.yml?raw";
import webValidation from "./code-profiles/web.code-validation.sh?raw";
import goValidation from "./code-profiles/go.code-validation.sh?raw";
import evidence from "../../scripts/code-evidence.mjs?raw";
import patch from "../../scripts/code-patch.mjs?raw";
import { gitBlobSha, PROFILE_PATHS, type ProfileFile, type ProfileKind } from "./code-onboarding";

const SOURCES: Record<ProfileKind, Record<keyof typeof PROFILE_PATHS, string>> = {
  web: { workflow: webWorkflow, evidence, patch, validation: webValidation },
  go: { workflow: goWorkflow, evidence, patch, validation: goValidation },
};

export async function profileFiles(kind: ProfileKind): Promise<ProfileFile[]> {
  const src = SOURCES[kind];
  return Promise.all((Object.keys(PROFILE_PATHS) as (keyof typeof PROFILE_PATHS)[]).map(async (k) => ({ path: PROFILE_PATHS[k], content: src[k], sha: await gitBlobSha(src[k]) })));
}

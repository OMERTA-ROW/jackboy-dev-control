# Everything still needed to turn CODE on

Read-only. No code, CODE switch, Emergency Stop, publishing or paid-call changes.

## A. Lovable secrets (Project Settings → Secrets)

| Name | Set? | Where the value comes from |
|---|---|---|
| CODE_PROVIDER_API_KEY | no | OpenAI → project "Jackboy OMNI CODE Test" → API keys → create key |
| CODE_GATEWAY_PRICES | no | Enter exactly: `{"gpt-6-luna":{"inputPerMillionUsd":0.2,"outputPerMillionUsd":0.75,"maxInputTokens":922000,"maxOutputTokens":128000}}` |
| CODE_GATEWAY_PER_CALL_CAP_USD | no | Enter exactly: `0.50` |
| CODE_GITHUB_TOKEN | yes | already set (GitHub token used to verify workflow runs) |
| CODE_TARGETS | yes | see section C for the exact value |

## B. GitHub (repo OMERTA-ROW/jackboy-dev-control)

| Name | Set? | Value |
|---|---|---|
| Actions variable `CODE_RUNNER_AUTH_URL` (CODE and CODE-PUBLISH environments) | unknown (no read access) | Enter exactly: `https://jackboy-dev-control.lovable.app` |
| Environment `OPENAI_API_KEY` | legacy, not needed | delete when convenient |

## C. Resync the pinned workflow version and CODE target

Today: GitHub's live `.github/workflows/code.yml` on `main` is version `ebc71c1923c3d6ab925ec6b9e4fa971e311f3761`, and the database pin is the same version. The database half already matches.

Steps:
1. Open Settings → CODE in Jackboy, signed in as owner, and press refresh workflow evidence. It compares GitHub, CODE_TARGETS and the database. If it shows "matching", nothing to do yet.
2. If CODE_TARGETS is reported stale, replace its value in Project Settings → Secrets with exactly:
   `{"OMERTA-ROW/jackboy-dev-control":{"ref":"main","workflowSha":"ebc71c1923c3d6ab925ec6b9e4fa971e311f3761"}}`
3. Refresh again and confirm "matching".
4. After the model pull request (section D, step 1) merges, the workflow version changes. Repeat: read the new version from Settings, put it in CODE_TARGETS (same shape, new SHA), and approve the audited database pin update (done by me only with your explicit approval). Both copies must match or CODE stays blocked.

## D. Remaining blockers (in order)

1. Model name: a reviewed pull request adding `model: gpt-6-luna` to the coding step. Without it the gateway refuses every call. Then do section C step 4.
2. Gateway host: run it on the published Lovable app (Railway cannot reach the database). Needs your publish approval after the secrets above are saved.
3. Spending enforcement: `provider_hard_cap_verified` is false and the switch requires it plus a fresh usage reading (under 5 minutes old). No verified way to set this exists yet; needs a reviewed design.
4. Total $10 spending guard: not built. Needs build + test approval.
5. Final: you release Emergency Stop and turn CODE on yourself with passkey. I will not.

## Proposed next step

On approval, prepare the one-line model pull request as a draft only. No merge, no secret, pin, CODE or Emergency Stop changes.

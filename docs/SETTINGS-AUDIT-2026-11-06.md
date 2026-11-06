# Jackboy settings audit: Lovable, Railway, GitHub (read-only)

Status: **CODE activation is BLOCKED.** Emergency Stop stays ON and CODE stays OFF. No setting value was read, created or changed. The 17-field form never opened, so nothing was saved.

## Main findings

1. **Do not add `CODE_PROVIDER_API_KEY` to Lovable.** Only the CODE provider gateway reads it. The GitHub runner sends calls to whichever site the GitHub repository variable `CODE_RUNNER_AUTH_URL` points to. I could not read that variable because my GitHub access is denied. If it points to Railway, Lovable never needs this key.
2. **Railway cannot run the gateway yet.** Before any provider call, the gateway reads the approved CODE task from the Jackboy database. That needs `SUPABASE_SERVICE_ROLE_KEY`, and Lovable Cloud does not make that key available. So a Railway gateway safely refuses every call until a separate, reviewed way to access the database is approved. **This blocks activation.**
3. **The 17-field form left out 2 required gateway settings:** `CODE_GATEWAY_PRICES` and `CODE_GATEWAY_PER_CALL_CAP_USD`. Without them, the gateway refuses calls.
4. **No total $10 spending-reservation guard exists in the code.** The code only has a daily-limit reservation check. The cumulative $10 guard is **unverified, so activation stays BLOCKED.**
5. **None of the 17 fields is needed in Lovable for the current locked state.** Each one turns on a single optional feature, has a built-in default, or belongs on Railway.

## A. Railway (Jackboy service): needed before the gateway can work

The CODE gateway needs these. Unless noted, I can't check which names exist on Railway.

| Name | Purpose | Where the owner gets it | Depends on |
|---|---|---|---|
| `CODE_PROVIDER_API_KEY` | OpenAI key used only by the gateway | OpenAI project with a spending limit. The owner says it's already set, but I can't check that | - |
| `CODE_GATEWAY_PRICES` | Price list per model, used to estimate the cost of each call | Owner sets it from OpenAI's published prices | Provider key |
| `CODE_GATEWAY_PER_CALL_CAP_USD` | Spending limit per call | Owner chooses it (must fit under the $5 daily limit) | Prices |
| `CODE_GITHUB_TOKEN` | Confirms the GitHub run that is calling | Exists in Lovable. Railway copy not checked | GitHub App/token |
| `SUPABASE_URL` | Database address | Same value as the public `VITE_SUPABASE_URL` | - |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend database access | **Not available on Lovable Cloud. BLOCKER** | Needs a reviewed design |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | Public values used when building the app | The project's existing public values | - |
| `NITRO_PRESET` | Builds the app to run as a Node server | Fixed value: Node server | - |
| `PORT` | Network port the app listens on | Railway sets this automatically | - |

Only needed if the OMNI link is also served from Railway: the seven `OMNI_LINK_*` settings, `JACKBOY_LINK_ORIGIN` and `OMNI_LINK_BEHIND_HTTPS_PROXY=true`. Leave `OMNI_LINK_ENABLED` and `OMNI_LINK_NODE_RUNNER_ENABLED` unset or off.

## B. GitHub (repository and CODE environment)

| Name | Purpose | Status |
|---|---|---|
| `CODE_RUNNER_AUTH_URL` (repository variable) | The site the runner sends gateway calls to. It must be the Railway site if Railway hosts the gateway | Can't check (access denied). Owner should confirm |
| `OPENAI_API_KEY` (CODE environment) | Old setting name. The runner must never hold a provider key | Remove it when convenient. It's no longer a readiness requirement |

## C. Lovable: the 17 fields, sorted

Names already saved in Lovable (I checked names only): none of the 17. Related settings that already exist: `OPENAI_API_KEY` (voice), `CODE_GITHUB_TOKEN`, `OMNI_API_URL`, `OMNI_API_KEY`, `OMNI_CALLBACK_SECRET`, all seven `OMNI_LINK_*`.

| # | Name | Verdict | Purpose / source / depends on |
|---|---|---|---|
| 1 | `CODE_PROVIDER_API_KEY` | **Not needed in Lovable (duplicate)** | Only needed if `CODE_RUNNER_AUTH_URL` points to the Lovable site |
| 2 | `OPENAI_ADMIN_KEY` | Optional | Owner's "Sync provider costs" button on the dashboard. OpenAI organization admin key with usage-read access. For information only: it can never allow CODE to run |
| 3 | `OPENAI_CODE_PROJECT_ID` | Optional (needs #2) | OpenAI project ID (`proj_…`) |
| 4 | `OPENAI_CODE_API_KEY_ID` | Optional (needs #2) | ID of the gateway key (`key_…`), never the key itself |
| 5 | `BRAVE_SEARCH_API_KEY` | Optional | Live web research. Get it from the Brave Search API dashboard. Research says "not configured" until it's set |
| 6 | `RAZUL_API_URL` | Optional (future) | Only once a live RA'SUL service exists |
| 7 | `RAZUL_API_KEY` | Optional (needs #6) | Read and feedback key from RA'SUL |
| 8 | `PUBLIC_APP_ORIGIN` | **Redundant** | Already defaults to the published Jackboy address |
| 9 | `JACKBOY_CALLBACK_URL` | **Redundant** | Has a built-in default callback address |
| 10 | `FOUNDRY_WEBHOOK_SECRET` | Optional | GitHub push webhook. The owner makes one random value and enters it both in GitHub's webhook settings and in Lovable |
| 11–13 | `OMNI_DISPATCH_ORIGIN`, `OMNI_DISPATCH_CLIENT_ID`, `OMNI_DISPATCH_HMAC_SECRET` | Not needed now | Sending jobs to OMNI is off. They come from OMNI's dispatch setup and need separate approval |
| 14–15 | `OMNI_DISPATCH_CALLBACK_CLIENT_ID`, `OMNI_DISPATCH_CALLBACK_SECRET` | Not needed now | Callbacks from OMNI, also off. These depend on 11–13 |
| 16 | `LOVABLE_ACCOUNT_API_KEY` | Not needed (name blocked) | Only changes a "linked" label. The form rejects names starting with `LOVABLE_` |
| 17 | `LOVABLE_DEPLOY_API_KEY` | Not needed (name blocked) | Publishing stays owner-controlled. Using it would need a renamed setting and a separate approval |

Nothing is removed. Redundant: 1 (as a Lovable copy), 8, 9 and the old GitHub `OPENAI_API_KEY`. Blocked names: 16, 17.

## Owner order, one step at a time

1. Confirm in GitHub that `CODE_RUNNER_AUTH_URL` is the Railway Jackboy site, with no path at the end.
2. In Railway, check that `CODE_PROVIDER_API_KEY` exists, then add `CODE_GATEWAY_PRICES` and `CODE_GATEWAY_PER_CALL_CAP_USD`.
3. In Railway, add `CODE_GITHUB_TOKEN`, `SUPABASE_URL`, the three `VITE_SUPABASE_*` values and `NITRO_PRESET`.
4. Approve a separate review for how Railway reaches the database, which replaces `SUPABASE_SERVICE_ROLE_KEY`. **This must be done before any CODE run.**
5. Approve building and verifying the total $10 spending-reservation guard. **Still BLOCKED.**
6. Optional, whenever you like: in GitHub, remove the old CODE environment `OPENAI_API_KEY`.
7. Optional, only for features you want: Brave (#5), Foundry webhook (#10), cost sync (#2–4), RA'SUL (#6–7).
8. Leave dispatch (#11–15), #1, #8, #9, #16 and #17 unset.

## After approval

- Add this audit task to the roadmap and save this report as a project doc for future reference.
- No code, settings, flags, publishing or paid calls change.

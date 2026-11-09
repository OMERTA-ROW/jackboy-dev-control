# Post-publish acceptance check (read-only result)

Nothing was run, reserved, dispatched, changed or published.

## Results

| Item | Result | Evidence |
|---|---|---|
| Live version proven | PASS (live) | `/api/public/version` → commit `9b31fff`, tree `2d3706b`, dirty=false, built 02:31 UTC Nov 9 |
| Live build includes $1 test control | PASS (live version + source) | Acceptance gate commit is an ancestor of live `9b31fff`; Settings page returns 200 (private content is not readable signed-out) |
| Fixed `docs/CODE-ACCEPTANCE.md` target, reviewed lane | PASS (source only) | `src/lib/code-acceptance.ts`; not viewed on the live page |
| Fresh owner passkey (`code_acceptance_test`) | PASS (source only) | `src/lib/step-up.ts` |
| $1 / $5 / $10 limits | PASS (source only) | existing spend guards reused; last live read showed $0 spent |
| GitHub CODE + CODE-PUBLISH approvals | PASS (source only) | reviewed-lane environments in `code-lane.ts` / `code.yml` |
| Emergency stop / Kill Switch | PASS (source only) | unchanged; last live read showed both off |
| Fail-closed publish gate | PASS (source only, 11 tests) | `code-runner-auth.server.ts` refuses 409 on bad/missing patch |
| GitHub main matches live | BLOCKED | GitHub `main` = `997179e`, which is 56 commits behind live `9b31fff`; readiness requires live = main |
| GitHub artifact download permission | UNVERIFIED | never exercised; only a real run proves it |
| $1 test itself | NOT RUN | owner has not approved spend |

## Single next safe action
Sync the project's code to GitHub `main` so it reaches `9b31fff` (no CODE run), then re-run this read-only check signed in as owner to view the card live.

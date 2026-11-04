# CODE hosted-runner acceptance

`.github/workflows/code-acceptance.yml` runs on a GitHub-hosted runner with a read-only token, no secrets and no environments. Tests run inside an empty network namespace (`unshare -n`, loopback only), and a canary step fails the job if a paid-provider host is reachable. It cannot dispatch CODE, open PRs or write to the repository.

It runs `tests/code-*.test.mjs` and `tests/omni-*.test.mjs`, including the encrypted-loopback `TestCrossLanguage` test against the OMNI `inbox/` checkout (`OMERTA-ROW/Omni`, pinned to a commit that contains `inbox/internal/link`, currently only on Omni draft PR #3). The job fails if any node test is skipped, so a missing OMNI checkout cannot pass silently.

Not covered here, because they need a disposable repository and owner approval: a real hosted CODE run, a real draft PR created by the publish job, and live Emergency Stop and cancellation against GitHub. Those are covered today only by mocked-transport tests.

## Disposable database and release checks

The full acceptance job installs the test-only `pg` driver before network isolation,
then initializes PostgreSQL inside the same empty network namespace as the tests.
Only loopback is enabled. `STAGING_PG_URL` names this disposable database;
`STAGING_PG_MODULE_FROM` points to the temporary driver installation. No production
connection, credential or customer data is used.

Tests run as the unprivileged runner with synthetic Supabase-managed objects and
one throwaway database per test. The complete chain through 0042, rollback,
reservation concurrency, cancellation, reconciliation and audit failures execute
rather than skip. The existing no-skips assertion remains mandatory. A shell
trap stops PostgreSQL even when the suite fails; existing test helpers drain
closing clients before dropping only their generated test databases.

`Verify` supports manual dispatch and has a standalone blocking
`tsc --noEmit --strict` job plus gateway-surface ESLint. `Jackboy checks` no longer
ignores TypeScript failures or falls back to a non-frozen dependency install.
Default GitHub CodeQL analysis on repair PRs supplies a fresh JavaScript/TypeScript
and Actions scan; an old dynamic scan that cannot be retried is not fresh evidence.
These workflows never deploy, apply production migrations or dispatch CODE.

The application repository's `CODE-PUBLISH` environment requires the owner,
disallows self-review and administrator bypass, and accepts protected branches
only. Main requires passing release checks and code-owner review; the root
`.github/CODEOWNERS` assigns the owner explicitly. An owner-authored change or
owner-triggered publishing run still needs an eligible independent approval;
these protections must not be bypassed to make a one-person release pass.
Private TEST/LIVE environment-reviewer support remains a separate GitHub-plan
limitation, not something application-repository protections resolve.

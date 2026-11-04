# CODE hosted-runner acceptance

`.github/workflows/code-acceptance.yml` runs on a GitHub-hosted runner with a read-only token, no secrets and no environments. Tests run inside an empty network namespace (`unshare -n`, loopback only), and a canary step fails the job if a paid-provider host is reachable. It cannot dispatch CODE, open PRs or write to the repository.

It runs `tests/code-*.test.mjs` and `tests/omni-*.test.mjs`, including the encrypted-loopback `TestCrossLanguage` test against the OMNI `inbox/` checkout (`OMERTA-ROW/Omni`, pinned to a commit that contains `inbox/internal/link`, currently only on Omni draft PR #3). The job fails if any node test is skipped, so a missing OMNI checkout cannot pass silently.

Not covered here, because they need a disposable repository and owner approval: a real hosted CODE run, a real draft PR created by the publish job, and live Emergency Stop and cancellation against GitHub. Those are covered today only by mocked-transport tests.

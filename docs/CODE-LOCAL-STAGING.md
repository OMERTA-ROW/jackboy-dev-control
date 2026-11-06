# CODE local staging fixture

The local-only migration in `tests/code-local-staging.test.mjs` runs inside a new
in-memory PGlite instance with synthetic data. It removes the 0037 constraint only
in that disposable instance, leaves the flag false and CODE disabled, checks the
$5 daily bound, service-role privileges, owner-only emergency stop and audit,
and restores the constraint. It accepts no database URL and is not in either
deployable migration directory. It is not a migration for a hosted environment.

Run from the repository root with `node --test tests/code-local-staging.test.mjs`.
The separate Mothership interop tests use isolated PGlite databases and verified
loopback TLS; they do not execute CODE or send paid provider requests.

These fixtures do not verify real credentials, a live passkey, actual provider
spend, hosted audit durability, network isolation or production rollback. The
owner-provided screenshot shows a $10 enforced monthly project setting and $0.00
displayed spend at capture time; provider enforcement can overshoot and reset
monthly. No shared cross-service cumulative ledger is established. The 0037
constraint and $5 daily limit remain unchanged in the production migration chain.
Do not use this fixture as a reason to enable CODE or change production controls.

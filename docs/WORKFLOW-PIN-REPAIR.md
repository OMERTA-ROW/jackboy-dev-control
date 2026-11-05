# Workflow pin repair and readiness — November 5, 2026

## Verified evidence

At 21:31:39 UTC, GitHub main's `.github/workflows/code.yml` was read independently. Its decoded bytes were hashed using Git's blob header (`blob <byte-length>\0` plus bytes). Both the calculated SHA and GitHub's SHA were:

`ebc71c1923c3d6ab925ec6b9e4fa971e311f3761`

Both `CODE_TARGETS` and production `code_runtime_controls.allowed_targets` still contained:

`82c0c44e9afeacb45e666ff131e34b90ae2da23b`

Scope in both copies remains exactly one repository, `OMERTA-ROW/jackboy-dev-control`, ref `main`.

At 21:31:40 UTC, production reads confirmed `enabled=false`, `kill_switch=true`, `provider_hard_cap_verified=false`, no active request/run, and the 0037 constraint `CHECK (provider_hard_cap_verified = false)`. Nothing changed in production. No CODE dispatch, paid model call, GitHub mutation, publication, secret change or activation was performed.

## Proposed repair — not applied

Exact replacement mapping for both references:

```json
{"OMERTA-ROW/jackboy-dev-control":{"ref":"main","workflowSha":"ebc71c1923c3d6ab925ec6b9e4fa971e311f3761"}}
```

**There is no transaction across the managed configuration store and PostgreSQL.** The existing `setCodeSafetyTarget` updates only the database and audits separately; it must not be used as an atomic two-copy repair. A promise to update both references atomically would be incorrect.

Recommended alternative, subject to explicit owner approval:

1. Re-read GitHub workflow bytes and both old copies immediately before writing; abort if workflow or scope changed.
2. Verify Stop ON, CODE disabled, no active run and 0037 unchanged. Retain these states throughout.
3. Update only the `CODE_TARGETS` mapping in Jackboy's managed settings. No GitHub environment or secret changes.
4. Read back the effective setting. The intermediate mismatch continues to deny CODE admission.
5. In one database transaction, lock the controls row, require the exact expected old mapping and safety states, update only `allowed_targets` and `updated_at`, and append an audit record identifying the authenticated owner approval, old/new mapping, GitHub byte-hash evidence and coordinating actor. Roll back the database update if the audit insert fails.
6. Read back both references and compare with live GitHub bytes. A failure leaves CODE stopped and is reported explicitly; do not claim rollback of the separate setting or automatic completion.

This is a **coordinated fail-closed repair**, not a cross-store atomic update. If strict atomicity is mandatory, a separately reviewed single-authoritative/versioned configuration design is required first. No such architecture or migration is authorized here.

## Completed checklist

| Task | Status | Evidence / next action |
|---|---|---|
| Current workflow blob | PASS | Independent byte hash equals GitHub SHA above, 21:31:39 UTC. |
| Stored pin alignment | OWNER ACTION | Both copies stale; approve the coordinated repair or choose strict-atomic redesign. |
| Production stop / disabled / 0037 | PASS | Production database read, 21:31:40 UTC; unchanged. Supervised switch remains disabled. |
| CODE and CODE-PUBLISH gates | PASS | Live metadata, 21:32:13–29 UTC: required reviewers, no self-review, no admin bypass. Not runner acceptance. |
| Permanent checklist | PASS (preview only) | Settings → Autonomous Activation Readiness; dated observations and live safety evidence, no activation path. |
| OMNI #1 / #3 | OWNER ACTION | Both open drafts, unmerged at 21:31:39 UTC. Review #1 then stacked #3. |
| OMNI bridge | BLOCKED | Published endpoint 503 `link_disabled`, 21:32:10 UTC; session/inbound tables absent. Dedicated HTTPS bridge/storage/config not verified. |
| Provider gateway | BLOCKED | Published endpoint 503 unconfigured, 21:32:08 UTC; no upstream invocation. Exact missing pricing/cap production configuration is not inferable from this response. |
| Hard spending enforcement | BLOCKED | False invariant prevents admission. Per-call ceilings and delayed cost reports do not prove independent hard daily enforcement. |
| Runner isolation acceptance | NOT TESTED (production) | Existing local/isolated tests not rerun; do not count them as production proof. Review existing CI evidence for exact commit. |
| Published commit | NOT TESTED | GitHub main is `38664ae313c5275858d955615cd5bad071dab81e`; zero Jackboy GitHub deployment records. Neither establishes actual published commit. |
| Backup / restore | OWNER ACTION | Prior owner-reported snapshot Nov 3, 23:38 UTC. No inventory access or restore test; request current UTC timestamp. |
| Physical passkey | NOT TESTED | No physical-device assertion; no browsing prompt introduced. |
| App least privilege | OWNER ACTION | Live installation selects all repos and includes workflow write; permissions not changed. |

## Remaining owner steps — do not activate

- **OMNI:** review https://github.com/OMERTA-ROW/Omni/pull/1 and then https://github.com/OMERTA-ROW/Omni/pull/3. Separately authorize session storage and HTTPS hosting. Follow `docs/OMNI-SECURE-LINK.md`: scoped `OMNI_LINK_CLIENT_ID`, `OMNI_LINK_PROJECT_ID`, `OMNI_LINK_OWNER_ID`, `OMNI_LINK_APPROVAL_ID`, `OMNI_LINK_APPROVAL_EXPIRES_AT`; independent managed `OMNI_LINK_BOOTSTRAP_KEY` and `OMNI_LINK_HMAC_SECRET`. No values in chat. Do not enable the restricted Node runner on the hosted app runtime. Managed Cloud does not expose a service-role key; the dedicated-host credential boundary remains an unresolved provisioning requirement, not an instruction to extract that key.
- **Gateway:** separately authorize Jackboy-only `CODE_PROVIDER_API_KEY`, `CODE_GATEWAY_PRICES`, `CODE_GATEWAY_PER_CALL_CAP_USD`. Never provision the provider key on the runner. Verify published configuration without a paid call; retain the spending block.
- **Spending:** design independent hard enforcement and test bypass/failure/cost-spike cases before any separately approved change to 0037. Owner approval alone cannot bypass it.
- **Deployment:** obtain a trusted Lovable publish record tied to its serving commit. Do not publish merely to claim readiness.
- **Backup:** More → Database → Manage → Backups is the only backup-inventory evidence. For isolated recovery testing, export through Manage → Settings → Export data and restore into a separate owner-owned project. Neither daily snapshots nor the export include storage files. An in-place restore loses post-snapshot data, reverts schema and is permanent; export current state first.
- **Passkey:** on the real device at the published origin, verify an action-bound sensitive operation without releasing Stop or enabling CODE. Do not remove the original credential for testing.
- **GitHub App:** GitHub Settings → Developer settings → GitHub Apps → the installed Jackboy App → Permissions & events: review removal of Workflows write and any unneeded Issues write. Under Installed GitHub Apps → Configure, review selected repositories rather than all repositories. Do not remove repos needed by other approved work without review. Keep intended Contents/Pull requests read-write and Actions read only where required; separately review Checks read. These are owner actions, not changes performed here.

## Next task

Resolve the two-copy pin repair approval first. Independent spending enforcement remains the next unconditional activation blocker, even after pins match. OMNI and CODE are separate acceptance boundaries; a reverse OMNI session does not authorize CODE.
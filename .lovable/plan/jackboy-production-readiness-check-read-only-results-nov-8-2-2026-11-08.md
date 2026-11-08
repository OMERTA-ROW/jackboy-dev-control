# Jackboy production readiness check — read-only results (Nov 8 2026, 06:00 UTC)

Nothing was changed. This is evidence only. Approving this card does not trigger any action.

| Item | Result | Evidence |
|---|---|---|
| Production identity | PASS | One Lovable Cloud backend serves both preview and the published site (platform project info). Credentials not shown. |
| Deployed commit | BLOCKED | The code workspace is at `4ce3b437…` (Nov 8 05:51 UTC). The live site does not report its version, and no tool here can read the published build's commit. The deployed SHA is not proven. |
| Migration 0055 | BLOCKED (pending) | Repo journal idx 55 = `0055_omni_authorization_expiry`. Live function `expire_omni_project_authorizations` does **not** exist. The applied-journal table is unreadable (permission denied). Earlier owner-records updates had been applied as "0055/0056" in preview work, but `owner_omni_handoffs`/`owner_jax_manifests` are not in the live table list, so that numbering conflicts with merged main. Reconciliation is required before applying. |
| Backup / PITR | BLOCKED (unverified) | No tool can read backups. Lovable Cloud keeps daily backups for about 14 days. **PITR is not available.** The latest recovery point is shown only under More → Database → Manage → Backups. |
| Restore verification | BLOCKED | No isolated restore test is on record. |
| GitHub sync | PASS | GitHub `main` = `4ce3b4373a32d355618dfcd1ec9a75992d1f10ed`, which matches the workspace HEAD. |
| Deployment readiness | BLOCKED | Blocked by the migration conflict, an unproven deployed SHA and an unverified backup. |

## 0055 impact on OMNI authorization
- Dependencies: `user_roles`, `omni_project_authorizations` (`revoked_at`/`revoked_reason`/`expires_at` columns exist), `omni_dispatch_grants`, `site_log`.
- Effect: when the owner reads diagnostics, expired OMNI project access and its dependent job grants are revoked automatically and logged.
- Live today: 0 of 0 authorizations are active, so applying it revokes nothing right now.
- Recovery if grants are revoked: revocation cannot be undone by design. Create a new authorization through the existing fresh-passkey "grant OMNI access" flow. Restoring a database backup would roll back everything after the snapshot, so it is not a recommended path.

## Publishing flow (owner)
1. Lovable publishes the current workspace code (now `4ce3b437`) with Publish → Publish changes. There is no exact-commit pinning: whatever the workspace holds gets published.
2. Jackboy's commit-bound passkey approval is done on the site itself (Settings → Autonomous Activation). It is never done in chat.
3. Database updates go live immediately, without publishing.

## Owner actions needed
1. Open More → Database → Manage → Backups and confirm the newest UTC timestamp. Optionally, export the data and test a restore into a separate project.
2. Approve a separate task to reconcile the migration numbering (0055 conflict) and then apply 0055.
3. Publish, then confirm the version (adding a version endpoint needs an approved code change).

## Permissions unavailable here
Reading the migration journal, backup inventory and published build commit.

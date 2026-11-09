# Backup recovery and database update 0059 — read-only findings

Nothing was changed. No restore, export, migration or setting change was made.

## Results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Newest backup exists | PASS (your report) | You saw Nov 8 2026 23:39:36 UTC. I can't read the backup list myself. |
| 2 | Visible "Restore" overwrites production | YES — do not click | Lovable docs: Restore rolls back this same project's database in place, both structure and data. Everything written after 23:39 UTC Nov 8 is lost. One database serves both preview and the live site. |
| 3 | Isolated test restore inside Lovable | BLOCKED | Docs: the Backups page only restores in place. Remix copies structure only, no data. |
| 4 | Isolated test via export | PASS (docs only) | More → Database → Manage → Settings → Export data → Database → Export → Start export. Then load it into a separate project you own. Not tried on your account. |
| 5 | Backups include roles/grants | UNVERIFIED for your account | Docs say backups and exports cover the full database, structure and data, including user accounts. They don't separately list grants, so only a test restore proves it. Storage files, secrets and sign-in settings are NOT included. |
| 6 | Point-in-time recovery | NOT AVAILABLE (docs) | Daily snapshots only, about 14 days kept. No account-specific evidence beyond your screenshot. |
| 7 | Update 0030 | PASS — installed | Two files share number 0030. `0030_omni_sessions` is listed in the update list. `0030_repository_resync_baseline` is not listed, but all its tables, 5 functions and 2 triggers exist live. The objects are present, so the missing history entry doesn't mean anything is missing. |
| 8 | Update 0059 | FAIL — not installed | In the update list and source, but none of its 4 objects exist live: `set_guardian_limits`, `guard_code_acceptance_reservation`, the `code_acceptance_reservation_guard` trigger and `code_acceptance_guard_status`. The database-side limit on $1 test reservations is not active, so only the app code enforces it. |
| 9 | Install history table | UNVERIFIED | My read access can't see the history table directly. Earlier evidence is reused. |

## Safest next steps (in order)

1. Don't click Restore. It doesn't do a test, it rolls back the live database.
2. Optional recovery proof: run Export data once (allowed every 24 hours) and keep the file. A restore into a separate project you own is the only real restore test.
3. Approve installing 0059 as a separate step. It only adds things (new functions and one trigger, no deletes). Until it's installed, the $1 test is guarded only by app code.
4. Leave 0030 alone. Its objects are live. Fixing the history record is optional cleanup and needs separate approval.

Keep the $1 CODE test paused until step 3 is done.

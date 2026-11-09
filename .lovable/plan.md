# Read-only production configuration audit — Nov 9 2026, 05:30 UTC

Nothing changed. "Live" = observed in production now; "Source" = code only.

| # | Gate | Result | Evidence |
|---|------|--------|----------|
| 1 | Published commit/tree | BLOCKED | Live `/api/public/version`: commit `a25f54f`, tree `9754e49`, clean, built 03:00 UTC (live). GitHub `main` = `3bfcac7` (live) and does not match, so the live version is not yet proven. The repo link itself sits in Lovable's Git settings, which I can't read. |
| 2 | Database identity | PASS | One Lovable Cloud database serves both preview and live, PostgreSQL 17.11 (live). |
| 3 | Migration 0059 | UNVERIFIED | `0059_sync_safety_guards` is in the source journal. The installed-update history can't be read with my access (permission denied). The guards it adds are present (see 4). |
| 4 | Guards and triggers | PARTIAL PASS | All 6 spend and activation triggers are enabled (live). Guardian and the acceptance test have no database functions of their own; they run as app code (source). |
| 5 | Backups and restore | UNVERIFIED | I have no access to backup records. Lovable Cloud provides daily backups kept about 14 days, with no point-in-time restore (docs). No restore test has been run. |
| 6 | GitHub App binding | PARTIAL | Installation `177905883` (OMERTA-ROW) is stored (live). The stored App ID came back empty, so App `5582965` is UNVERIFIED. |
| 7 | Stops, limits, work | PASS | Kill Switch off, CODE emergency stop off, no stop requested (live). Limits $1 per task, $5 per day, $10 total (live). Spend meter OK at $0, provider hard cap verified, no spike (live). Provider cost sync has never run, so cost metering is only partly verified. 0 active runs, 0 held funds, 0 failures, 0 open passkey approvals (live). CODE switch is ON, limited to `OMERTA-ROW/jackboy-dev-control` @ main (live). |

## Owner actions needed for the missing evidence
1. Merge the newest `lovable-sync*` branch into GitHub `main` so it matches `a25f54f`.
2. Open More → Database → Manage → Backups and read the newest backup time (UTC). For a restore test, export the data and restore it into a separate project.
3. Confirm App ID 5582965 in the GitHub App settings (App ID only, no secrets).
4. Check migration 0059 with the migration-history inspect tool (read-only) once you approve leaving plan mode.

The audit stops here. Approving this plan only allows step 4's read-only inspect.

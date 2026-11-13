# Migration 0064 (OMNI configuration probe): read-only preflight and install plan

Nothing was changed. All facts below come from read-only queries at DB time 2026-11-13 21:01 UTC and from the files in the workspace.

## 1. Migration history check: PASS
- 0063 is recorded exactly once: row id 70, hash `30c0378c…6bfa`, created_at `1794461154900`. This matches the workspace file's SHA-256.
- 0064 is not applied. There is no history row with hash `55b00b54…8c82` or created_at `1794523200000`, and the function `omni_link_configuration_authorize` does not exist (0 matches).
- The history table has 70 rows, and the newest created_at is `1794461154900`. The 0064 journal timestamp `1794523200000` is later than that, so the migrator would not skip it.
- The 0064 file is 1,821 bytes, SHA-256 `55b00b5441ac0c80a428702bdce0ebd24590b11c8ddab0315b9e6b57f24c8c82`. Journal entry idx 64 already exists in the workspace, and `tests/migration-history-reconcile.test.mjs` pins it as newer than 0063.

## 2. One atomic install: feasible (with one caveat)
- The normal migration tool would generate a new numbered file (0065) and history row that duplicate 0064. Do not use it.
- Instead, use one raw-SQL-runner request. That runner was shown earlier to stop and roll back on error. The request contains:
  1. a lock,
  2. checks that stop on failure,
  3. the 0064 text unchanged,
  4. the history row,
  5. checks after the install,
  6. COMMIT.
- Any failure rolls back the whole request, including the history row.
- Caveat: the file is placed inside a wrapper, so the request is not literally the file by itself. The embedded part between the markers is hash-checked against `55b00b54…` before sending.

## 3. Security review of the function: PASS, with notes
- **Locked search path:** `SECURITY DEFINER SET search_path = ''`, and every table is named with its full schema. `hashtextextended`, `starts_with` and `pg_advisory_xact_lock` are built-in pg_catalog functions.
- **Execute rights:** REVOKE from PUBLIC, anon and authenticated; GRANT to service_role only.
- **Input checks:**
  - The client ID must match a strict pattern, and the nonce must be 32 lowercase hex characters.
  - A missing project or owner fails the existence checks, so it returns false.
  - The owner must hold the owner role, and the project must be active and created by that owner.
  - If the pause row is missing, the function treats the system as paused.
- **Nonces and rate limit:**
  - A per-client lock serialises concurrent calls.
  - Entries older than 10 minutes are purged only within the `link-config:<client>:` prefix.
  - Each client is capped at 60 checks per 10 minutes.
  - The nonce is stored once (primary key plus ON CONFLICT DO NOTHING), so a replay returns false.
  - The prefix keeps these entries separate from other callback nonces (6 rows exist today).
- **Log writes:** one `site_log` row on success only. Its values (category `config`, status `info`, a fixed summary) satisfy the existing table checks. The existing insert trigger `site_log_outbox` will also queue an outbox row. Refusals are not logged by the database; the server returns 403 instead.
- **Dependencies:** `owner_projects`, `user_roles`, `automation_policy`, `omni_callback_nonces` (RLS on) and `site_log` all exist. Today's lookups pass: project `f45d225f…` is active and owned by the single owner account.
- **Notes:**
  - The function deletes old nonce rows each time it is called (bounded, prefix-scoped).
  - Contention on the lock is per client only.
  - A refusal still burns the request: the function never says why, so the server only sees false.

## 4. Kill Switch and Step 2
- The Kill Switch is ON (`paused = true`). With the switch on, the function returns false and the probe answers `403 configuration_scope_denied`. Installing 0064 therefore gives no attestation while paused.
- Recommendation: do not turn off the Kill Switch for this. A safer way to read the configuration needs a separate, owner-approved rule change: a follow-up migration (0065) that allows only this metadata check while paused.
  - It would never issue sessions, jobs or approvals.
  - It would keep the owner and project checks, the nonce check, the rate limit and the log row.
  - It would write `paused_at_check = true` into the log summary.
  - That is a safety-policy decision, so it is not included here.
- Read-only alternatives that work today without any switch change:
  - the existing runner GET (405) and unsigned POST (401) checks,
  - the "Test OMNI link" panel,
  - the database queries below.

## Technical details

### Exact install request (one raw SQL run)
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('jackboy-migration-0064',0));
DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash='30c0378cd5255a82bf6bc0dc206739662b573ec395850cace5cb739e88696bfa' AND created_at=1794461154900) <> 1
    THEN RAISE EXCEPTION '0063 not recorded exactly once'; END IF;
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash='55b00b5441ac0c80a428702bdce0ebd24590b11c8ddab0315b9e6b57f24c8c82' OR created_at=1794523200000)
    THEN RAISE EXCEPTION '0064 already recorded'; END IF;
  IF (SELECT max(created_at) FROM drizzle.__drizzle_migrations) >= 1794523200000
    THEN RAISE EXCEPTION 'newer history row exists'; END IF;
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 70
    THEN RAISE EXCEPTION 'unexpected history count'; END IF;
  IF to_regprocedure('public.omni_link_configuration_authorize(text,uuid,uuid,text)') IS NOT NULL
    THEN RAISE EXCEPTION 'function already exists'; END IF;
END $$;
-- >>> 0064 BEGIN (verbatim, 1821 bytes, sha256 55b00b54…8c82)
<contents of drizzle/migrations/0064_omni_configuration_probe.sql, unchanged>
-- <<< 0064 END
INSERT INTO drizzle.__drizzle_migrations(hash, created_at)
  VALUES ('55b00b5441ac0c80a428702bdce0ebd24590b11c8ddab0315b9e6b57f24c8c82', 1794523200000);
DO $$ BEGIN
  IF to_regprocedure('public.omni_link_configuration_authorize(text,uuid,uuid,text)') IS NULL
    THEN RAISE EXCEPTION 'function missing after install'; END IF;
  IF has_function_privilege('anon','public.omni_link_configuration_authorize(text,uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.omni_link_configuration_authorize(text,uuid,uuid,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.omni_link_configuration_authorize(text,uuid,uuid,text)','EXECUTE')
    THEN RAISE EXCEPTION 'grant check failed'; END IF;
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 71 THEN RAISE EXCEPTION 'history count'; END IF;
END $$;
COMMIT;
```
Before sending, confirm that the text between the markers is byte-identical to the file (SHA-256 `55b00b54…`). If the run errors, stop: no retry and no edits.

### Rollback (only on separate owner approval, after a successful install)
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('jackboy-migration-0064',0));
DROP FUNCTION public.omni_link_configuration_authorize(text,uuid,uuid,text);
DELETE FROM drizzle.__drizzle_migrations WHERE hash='55b00b5441ac0c80a428702bdce0ebd24590b11c8ddab0315b9e6b57f24c8c82' AND created_at=1794523200000;
COMMIT;
```
The rollback leaves the `site_log` rows and the nonces in place; both are append-only or expire on their own.

### Read-only checks after install
```sql
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations WHERE id >= 70 ORDER BY id;
SELECT count(*) FROM drizzle.__drizzle_migrations;            -- expect 71
SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.omni_link_configuration_authorize(text,uuid,uuid,text)');
SELECT paused FROM automation_policy WHERE id=1;              -- unchanged
-- also re-read CODE enabled / Emergency Stop / spend caps unchanged
```

### Tests
- Local: run `tests/migration-history-reconcile.test.mjs`, `tests/omni-session.test.mjs`, and the configuration-probe unit tests.
- Recommended new tests (PGlite):
  - paused returns false,
  - a wrong owner or project returns false,
  - a replayed nonce returns false,
  - the 61st check within 10 minutes returns false,
  - success writes exactly one `site_log` row,
  - anon and authenticated cannot execute the function.

### Unresolved risks
- The wrapper is not the file alone. This is handled by the marker hash check.
- The live site needs a publish before the server code uses the function. Until then it fails closed.
- Refusals are not logged in the database.
- With the Kill Switch on, the probe returns 403. That needs the owner decision described above.

## Recommendation
- **Install 0064 as-is: GO.** It is harmless and fails closed while paused.
- **Turning off the Kill Switch for Step 2: NO-GO.**

## Approval requests (separate)
- A. "I approve running the single atomic install request above for migration 0064 (SHA-256 55b00b54…8c82) and its history row (created_at 1794523200000) once on production. Stop on any error, no retries. Keep the Kill Switch, Emergency Stop and CODE unchanged, and do not publish."
- B. (optional, later) "I approve drafting a follow-up migration that lets the read-only configuration check run while the Kill Switch is on." This would be reviewed before any install.

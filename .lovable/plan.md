# CODE workflow verification repair (prepared, not applied)

Decision: **BLOCKED** until the owner approves updating the approved workflow fingerprint in two places.

## Root cause
- PR #50 ("fix: add runner to CODE draft PR job", merged 2026-11-08 04:08 UTC, commit `71722ed`) added one line, `runs-on: ubuntu-latest`, to the `draft_pr` job in `.github/workflows/code.yml`.
- That changed the file's GitHub fingerprint from the approved `37368194…` to `72f48d39…`.
- Both stored approvals still name the old fingerprint: the database record and the `CODE_TARGETS` setting.
- The check therefore refused correctly. PR #59 did not touch `code.yml` (it only changed `jackboy-checks.yml`). The workflow is **active**, not disabled, and `main` is the default branch.

## Evidence (live, read-only, 05:56 UTC)
| Item | Value |
|---|---|
| Live `code.yml` on main, git blob | `72f48d395602c92d8af81d883ee6f85655eb56d0` |
| Live SHA-256 | `662c6288c667f84ca7d702b0b89042593c8ae0018f45b6615185e398319470ee` |
| Approved blob (DB + CODE_TARGETS) | `37368194f883bc1cf5175aecf4832945203b602b` |
| Approved SHA-256 | `fd87a5230b82d61c3743417f052cd58f260985207c14a777fcf3dcbb28e5a97e` |
| Diff | one line added (`runs-on: ubuntu-latest` in `draft_pr`), nothing removed |
| Permissions / environments | unchanged (prepare: CODE, draft_pr: CODE-PUBLISH, same scopes) |
| Workflow state | active (id 404702167) |
| Project copy of code.yml | identical to live (same SHA-256) |
| Safety | the old approved file had no runner for `draft_pr`, which GitHub rejects as invalid, so the change is a needed fix |
| Side effects of the failed attempt | 0 CODE jobs, 0 reservations, $0 spent; two passkey grants issued 05:51 and not reused |

## Repair (needs owner approval)
1. Database pin (one guarded update, only when no task is active and the old pin is still stored):
   ```sql
   UPDATE public.code_runtime_controls
     SET allowed_targets = '{"OMERTA-ROW/jackboy-dev-control":{"ref":"main","workflowSha":"72f48d395602c92d8af81d883ee6f85655eb56d0"}}'::jsonb,
         updated_at = now()
   WHERE singleton = true
     AND active_request_id IS NULL AND active_run_id IS NULL
     AND allowed_targets->'OMERTA-ROW/jackboy-dev-control'->>'workflowSha' = '37368194f883bc1cf5175aecf4832945203b602b';
   INSERT INTO public.audit_logs(actor, action, detail, outcome)
     VALUES (<owner id>, 'code.workflow_repinned',
       '{"from":"37368194f883bc1cf5175aecf4832945203b602b","to":"72f48d395602c92d8af81d883ee6f85655eb56d0","cause":"PR #50"}', 'ok');
   ```
2. `CODE_TARGETS` setting (secure form, same value):
   `{"OMERTA-ROW/jackboy-dev-control":{"ref":"main","workflowSha":"72f48d395602c92d8af81d883ee6f85655eb56d0"}}`
3. Re-run the read-only pin check: database, setting and live blob must all match. Until both are changed, CODE stays blocked (fail closed).
4. Then a **fresh** passkey and both GitHub approvals (CODE, CODE-PUBLISH) are still needed for the $1 test.

## Not changed
No bypass, no workflow or permission edits, no CODE dispatch, no passkey reuse, no autonomy. Only one regression test was added for this case.

# Owner-only Safety Status

Scope: Foundry e68257b1-b3ec-40c2-a231-534f33ce9489. Draft only; no deployment.

Authenticated owner GET /api/safety-status returns an uncached, sanitized snapshot. Existing server-side owner verification is required before source reads. Every attempt must write a fixed-field access audit; audit failure returns 503 without safety data. No request-selected project, arbitrary query, credentials, task instructions, raw audit detail, control mutations, RPCs or dispatches are supported. Reads use the runtime database connection and selected columns. Only the narrow access audit is written.

Source reads are individually bounded at 501 rows; more than 500 reports partial/blocked, never empty or complete. Missing tables/singletons/fields and invalid booleans are blocked. Snapshots expire after 60 seconds; consumers must reject expired snapshots and never cache them. Observation time describes a live database read, not the time a control last changed. Deployment/database identity still requires independent operator verification: the endpoint does not claim it is production from a URL alone.

Known gaps remain explicit: complete platform/cron/GitHub scheduler inventory, all external workers/branches, historical audit completeness and approval correlation, strict daily provider enforcement. These are BLOCKED, so the overall response can never approve activation. CODE requests that are neither denied nor expired require lifecycle review, including allowed requests that may have completed; no completion is guessed. Queued OMNI jobs require approval review, not automatic cancellation or dispatch.

## Production acceptance after separate deployment authorization

1. Verify the deployed commit and database identity independently. Compare its migration inventory against 0036-0038; missing CODE tables must remain BLOCKED. Do not apply migrations as part of a read.
2. From the approved owner session, GET the endpoint and retain the sanitized timestamped result. Verify nonowner and expired sessions cannot read it and an audit failure reveals no status.
3. Verify master/project Autopilot and dev are false, Foundry disabled/paused, CODE disabled, Emergency Stop true, no active request. Do not call getCodeSafetyState/getCodeSafetySettings for observational verification: they can persist pauses.
4. Independently obtain complete timestamped application, database cron and hosting/GitHub scheduler inventories. Retain pagination/coverage and enabled state. This endpoint cannot supply all of them.
5. Inspect every pending/active CODE request, its owner/session approval, expiry/revocation and execute/publish claims; reconcile all worker platforms, OMNI queues and GitHub branches. No Foundry-only inventory establishes global idle state.
6. Correlate immutable execution/audit records and approval identity; audit row availability is not completeness. Investigate the two observed legacy queued OMNI code jobs without dispatching them.
7. Verify strict metering and reviewed runner privilege isolation before requesting separately approved supervised CODE tests. Keep stop engaged and autonomy off. Deployment approval is not approval to release stop or execute paid work.

Observed during review (2026-11-03 evening America/New_York): connected Lovable database has Foundry disabled/paused, three inactive cron jobs, master/project Autopilot and Jackboy dev off. CODE runtime/usage/claim columns are absent. Two queued-unsent legacy OMNI code jobs have no code_request_id. Source identity against deployed runtime is not independently established. These are observations, not a full production PASS.

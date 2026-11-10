# Jackboy scoped OMNI dispatch v3

V3 is an opt-in extension of the existing scoped dispatch lane. The v2 request,
callback, and client remain unchanged. V3 submits the exact owner-approved
instruction text (build patches or test instructions) with the existing ordered
`jackboy.dispatch-payload/v2` digest, and never accepts a caller-selected shell
command. Status and cancel requests contain only the original immutable scope.

The Jackboy sender and callback receiver both require the exact value
`JACKBOY_DISPATCH_V3_ENABLED=true`; unset, `false`, `TRUE`, and every other value
leave the v3 paths disabled. V3 submission revalidates the live owner grant
before signing and again before transport. Status and cancellation are limited
to a scope recorded by a previously authorized v3 submission, so cancellation
can still be signed after its grant expires or is revoked without authorizing
new work. Manual grant revocation, project revocation, owner diagnostics, and
owner-initiated handshake/link-loss checks reconcile revoked or expired v3 jobs
through signed cancellation when v3 is enabled.

Outgoing request JSON is limited to 8192 UTF-8 bytes, with payload strings
limited to 6144 UTF-8 bytes and expiry strictly future, no more than 30 minutes
ahead, and no later than the owner grant expiry. JSON escaping can make an
otherwise in-limit payload exceed the envelope limit; such requests are refused
before signing or transport. V3 callbacks are limited to 8192 bytes and bind
the exact historical job scope, including the payload digest. Completed and
failed callbacks require a strict result object; the summary is limited to 500
Unicode characters and output to 6144 UTF-8 bytes. Fresh-nonce retries for the
same job/status are idempotent, while any reused nonce is rejected. Callback
events, nonces, results, and immutable v3 scope are stored transactionally in
private service-role-only tables. Later running/quarantined events do not
replace a terminal state.

The new database migration is `0062_omni_dispatch_v3.sql`; it is not applied by
this change. Jackboy's sender configuration names are
`JACKBOY_DISPATCH_V3_ENABLED`, `OMNI_DISPATCH_ORIGIN`,
`OMNI_DISPATCH_CLIENT_ID`, and `OMNI_DISPATCH_HMAC_SECRET`.
`OMNI_DISPATCH_CA_FILE` is optional: when unset or empty, HTTPS uses Node's
normal trusted certificates (including standard Railway HTTPS). When set, the
file supplies the custom CA; file or TLS errors fail the request without
falling back to system trust. Certificate verification remains enabled.
The callback receiver additionally requires
`OMNI_DISPATCH_CALLBACK_CLIENT_ID` and `OMNI_DISPATCH_CALLBACK_SECRET`.
The OMNI inbox continues to require its own `OMNI_DISPATCH_ENABLED` gate and,
only for separately approved execution, `OMNI_WORKER_ENABLED`. These flags and
settings are not changed or enabled here. The v3 lane remains receipt-only if
the remote worker is off.

Before any separately approved rollout, apply the database migration through
the normal reviewed process, provision separate matching managed secrets on
both services, verify the live OMNI receiver version and callback URL, and test
submission, status, cancellation, expiry, callback replay protection, and
revocation in an isolated environment. Do not treat a local test, callback
receipt, or deployed version as permission to enable dispatch or execution.

# Applied migrations 0075–0077 (reference copies only)

These three migrations are **already installed in the live database** (history rows 81–83,
`when` values in `journal-entries.json` match the live history rows exactly). Their files were
lost from `drizzle/migrations/` when the branch was reset to GitHub `main`, and only the
database migration tool may write that folder, so the owner chose to keep exact byte-for-byte
reference copies here instead (Nov 20, 2026).

- `0075_code_kill_switch_marker_check.sql` — check-only entry confirming the 0074 Kill Switch marker.
- `0076_omni_stop_trigger_where_armed.sql` — `omni_execution_stop_trigger()` disarms only armed connections.
- `0077_omni_idempotent_handshake_forward.sql` — repeated Mothership handshakes reuse the open session.

Nothing here is executed against any database. Do not copy these files into
`drizzle/migrations/` by hand and do not re-run them; re-recording them through the migration
tool would need separate owner approval.

SHA-256:
f9385580c8fc6cd8bb532ce36dade9b65160cbdcb5f850e53950ee1d7debfdca  0075_code_kill_switch_marker_check.sql
6953533f98d0bc610c0fa2266e7e6beaa2b4940f347b1d1754ddd025b9eff09a  0076_omni_stop_trigger_where_armed.sql
45181a3ad9278d0d447cf9c3ad5a3125eae62695c8aaafbf420f3b3a35e092de  0077_omni_idempotent_handshake_forward.sql

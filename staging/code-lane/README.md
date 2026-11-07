# CODE approval lanes: staged pieces

Nothing here is live. Every file needs the owner's separate approval.

- `code.yml` is the proposed replacement for `.github/workflows/code.yml` (`code.yml.diff` shows the change). It adds a `lane` input and picks `CODE-AUTO` / `CODE-PUBLISH-AUTO` only when Jackboy dispatches with `lane: auto`. Before claiming publish, it reports the patch's files and line counts so the server can re-check the real patch. The owner merges it through a reviewed PR, re-saves `CODE_TARGETS` with the new blob SHA, and re-pins with a passkey.
- `0051_code_auto_lane.sql` (plus `.down.sql`) adds the per-site switch table and the owner-only `set_code_auto_lane` function. It's tested in `tests/code-auto-lane.test.mjs`.

Until both are in place:
- every request stays in the reviewed lane, because `autoLaneAllowed` is false;
- the runner refuses any automatic identity;
- Settings shows trial labels only.

# OMNI link on Railway — plan

## Answer to item 3 (already checked, read-only)

The session storage is **applied**. Its contents were applied on Nov 5 at 22:36 UTC, but the database recorded it as change #44 rather than #30, because later changes already existed. The file `0044_omni_sessions.sql` is identical to `0030_omni_sessions.sql` apart from a trailing newline. Live read:
- Both private tables exist with row-level security on. They hold 0 sessions and 0 jobs.
- The link helper exists. Signed-in users can't run it or read the tables.

Nothing needs to be applied for item 3.

## Important blocker to decide on (not fixable in code)

`SUPABASE_SERVICE_ROLE_KEY` **is not available on Lovable Cloud.** Neither the owner nor Jackboy can read it. Without it, a Railway copy of the app can't reach the link storage, so every link request fails closed with `link_unavailable`. That's safe, but the self-test can never pass.

Options for later, which need a separate decision:
- **A.** Railway forwards only the storage step to a narrow, signed endpoint on the Lovable-hosted app. That app already holds database access. This needs new code and a security review.
- **B.** Move the backend to a self-managed database where you hold the key. This is a large migration and isn't recommended.

This plan doesn't build either option. It only prepares the route and lists the variables.

## Changes (after approval)

1. **HTTPS behind Railway's proxy** (link route only)
   - Railway's edge ends HTTPS and forwards plain HTTP with `X-Forwarded-Proto: https`. Today the route rejects these requests with `https_post_required`.
   - Add an explicit opt-in, `OMNI_LINK_BEHIND_HTTPS_PROXY=true`, set only on Railway. With it set, an `http:` request counts as HTTPS only when all of these hold:
     - the first `X-Forwarded-Proto` value is exactly `https`;
     - the forwarded host (or the Host header) equals the host of `JACKBOY_LINK_ORIGIN`;
     - `JACKBOY_LINK_ORIGIN` is a clean `https://` origin.
   - Every other check stays unchanged: POST only, exact path, no query string, the 8 KiB and two-second body limits, the signature over the exact path, and nonce/timestamp freshness.
   - Without the flag, behavior on the Lovable-hosted app is byte-for-byte unchanged.
   - `OMNI_LINK_ENABLED` and `OMNI_LINK_NODE_RUNNER_ENABLED` aren't touched, so the route keeps answering `link_disabled`.
2. **Node 26 pin:** add `"engines": { "node": ">=26" }` to package.json. Railway reads this to choose Node 26.
3. **Railway build/start config:** add a small `railway.json` that builds with the Node server target (`NITRO_PRESET=node-server`) and starts `node .output/server/index.mjs` on Railway's `PORT`. The Lovable build ignores this file and stays on its current target.
4. **Docs and readiness:** update `docs/OMNI-SECURE-LINK.md` and the readiness wording so the setup says "existing web route behind Railway's HTTPS edge". Remove the separate-server, bind-address and certificate-file steps. `scripts/omni-link-server.mjs` stays only for the existing local TLS test and is marked not for deployment. Record the decision in `AGENTS.md`.
5. **Tests**, one per rule, in the existing link test file:
   - Accepted: flag on, forwarded `https`, matching host.
   - Rejected with the flag off.
   - Rejected for forwarded `http` or a missing header.
   - Rejected when the host doesn't match.
   - Rejected for a non-https `JACKBOY_LINK_ORIGIN`.
   - Direct `https:` requests still behave as before.

## Item 4 — Railway production variables (names only)

Link identity and keys (same values as Jackboy's saved ones):
- `OMNI_LINK_CLIENT_ID`, `OMNI_LINK_PROJECT_ID`, `OMNI_LINK_OWNER_ID`
- `OMNI_LINK_APPROVAL_ID`, `OMNI_LINK_APPROVAL_EXPIRES_AT`
- `OMNI_LINK_BOOTSTRAP_KEY`, `OMNI_LINK_HMAC_SECRET`

Railway hosting:
- `JACKBOY_LINK_ORIGIN`: the Railway public `https://` address, with no path.
- `OMNI_LINK_BEHIND_HTTPS_PROXY`: `true`. This is new.
- `NITRO_PRESET`: `node-server`, used at build time.
- `PORT`: Railway sets this automatically.

Database access:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`: see the blocker above. Lovable Cloud can't provide it.

Build-time public values the app bundle needs:
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`

Must stay **off or unset** for now:
- `OMNI_LINK_ENABLED`, `OMNI_LINK_NODE_RUNNER_ENABLED`

No longer needed:
- `OMNI_LINK_TLS_CERT_FILE`, `OMNI_LINK_TLS_KEY_FILE`, `OMNI_LINK_BIND_ADDRESS`

Deliberately **not** on Railway (least privilege):
- GitHub App/token, `CODE_PROVIDER_API_KEY`, `OPENAI_API_KEY`, `LOVABLE_API_KEY`, `OWNER_EMAIL`, mail and other app secrets. Other pages on the Railway copy fail closed without them, which is intended.

## Untouched

- No self-test and no paid calls.
- No secrets changed, and both link flags stay off.
- Emergency Stop stays ON and CODE stays off.
- No publish, merge, deploy or GitHub changes.

## Risk to note

The Lovable build tool (bun) doesn't enforce `engines`, so adding it shouldn't affect the Lovable preview or publish. I'll confirm the preview build still passes after the change. I can't check the published build environment from here.

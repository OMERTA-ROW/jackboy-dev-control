# OMNI handshake refusal: read-only production audit and next fix

No code, settings, approvals or switches were changed. No handshake, self-test, job, paid call, publish or deploy was run. No values are shown.

## Verified facts (live production, jackboy-dev-control.lovable.app)
- Live server log: OMNI's two calls (01:54:15 and 01:54:18 UTC) both reached `POST /api/public/omni/link` on the published site. Both got 503 with body `link_disabled`. The published build that answered has content hash `c47e50d8…`.
- Nothing more has been logged on the live site since 01:54:18 UTC (checked at 02:03 UTC).
- In the live code, `link_disabled` means "one of the 7 link settings failed its checks". This check runs first, before any stored data, passkey or runner is used. So the database and the remote runner did not cause this refusal.
- Site Log: the last live reading of the settings by Jackboy's own server was your view at 23:15 UTC on Nov 7. It recorded "expiry expired". There are no OMNI link Site Log entries after that. A `link_disabled` refusal is never written to the Site Log, by design.

## Verified facts (preview/sandbox copy, not production)
- All 8 link setting names exist. OMNI_LINK_ENABLED reads exactly "true". Client, project, owner and approval IDs pass their format checks. The bootstrap and signing keys pass their checks too.
- OMNI_LINK_APPROVAL_EXPIRES_AT is the only failing check: it ran out about 28 hours ago (checked at 02:03 UTC).
- This copy already sees settings you added recently (OMNI_LINK_ENABLED and the 3 remote-runner settings). So it isn't running on a days-old snapshot. Yet it still holds the old expiry.

## Conclusion
The likely cause is that the expiry saved in Jackboy is still the old, expired one. Every other check passes, and the live refusal is exactly what an expired approval produces. Jackboy checks the expiry against its own saved setting, not Railway's. So a correct value on Railway can't fix this.

## Uncertainties
- No tool can read the live site's settings directly. Only the passkey-protected values panel does that, and I can't press it.
- If you edited the expiry after 23:15 UTC, the sandbox copy may not have picked up that one edit yet. In that case, the live site's reason would still be unconfirmed.
- The logs don't show when you published. The build that answered at 01:54 was the current published one, but this check is the same in every recent version, so build timing doesn't change the result.
- I can't tell whether Jackboy's approval ID matches Railway's. That only matters after the expiry is fixed.

## Exact next fix (your steps, no code)
1. Live site → **OMNI page → "OMNI link values for Railway" → Show values with passkey**. Read the expiry status. This is read-only and is the only check of the live site's own values.
2. If it says expired: press **Make a new approval (valid 23 hours)**. In **Project Settings → Secrets**, edit the existing **OMNI_LINK_APPROVAL_ID** and **OMNI_LINK_APPROVAL_EXPIRES_AT**. Paste each exactly, with no spaces or quotes, and save. Then put the same pair on OMNI's Railway service and redeploy OMNI.
3. Reopen the panel. All three values should show "valid". If it still says expired, publish once and check again.
4. Then you run the handshake. A pass shows `omni.link.handshake` in the Site Log.

## Optional code change (only with your OK)
Today a refusal only says `link_disabled`. I could have Jackboy also write one Site Log line naming the failed check by name only, e.g. "approval expired" or "link switch not true". It would be limited to one line per few minutes, so heavy traffic can't flood the log. The reply OMNI sees stays the same. A unit test would cover each named reason.

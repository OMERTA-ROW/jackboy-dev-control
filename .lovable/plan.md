# Why the live site still shows the OMNI approval as expired

## Findings (checked, no values shown)
- **The setting names are correct.** Jackboy has exactly one `OMNI_LINK_APPROVAL_EXPIRES_AT` and one `OMNI_LINK_APPROVAL_ID`. There's no misspelled or duplicate copy.
- **The code reads the setting fresh on every check.** Nothing is cached or saved in the database. The time must include a zone (for example `Z`), and the stored value has one, so this isn't a time zone problem.
- **The stored expiry is the old one.** Checked the same way the panel does: it's present, readable, and ended about **28 hours ago**. That's the same old expiry from yesterday, not a value made today.
- **The Site Log agrees.** Every time you've opened the values panel (19:19, 19:22, 19:32 and 23:15 UTC on Nov 7), it recorded "expiry expired". Nothing newer has been logged.
- **Most likely cause:** the new expiry never got saved in Jackboy's Secrets. It may have gone into Railway only, the save didn't go through, or the edit went into a different field. A second possible cause: the live site only picks up a changed secret when you publish *after* the change.

## No code fix needed
The panel and the link are reporting correctly. Changing code would hide a real mismatch. I won't make a new approval or overwrite anything.

## Your next steps (keep the approval you made today)
1. Open **Project Settings → Secrets**. Edit **OMNI_LINK_APPROVAL_EXPIRES_AT** and paste today's expiry exactly as it is in Railway: no spaces, no quote marks, ending in `Z`. Save. Check that **OMNI_LINK_APPROVAL_ID** matches Railway's too.
2. **Publish once after saving.** The live site only picks up changed secrets when you publish.
3. Tell me when that's done. I'll re-check validity only (valid / expired / hours left), with no values shown. Then reopen the OMNI page panel: all three values should show valid.
4. If it still shows expired after steps 1–2, I'll look again. The next step then would be checking that Railway's value hasn't already expired too.

## Optional small improvement (only with your OK)
Show "expired N hours ago" or "valid for N more hours" in the panel, so an old value stands out right away. Display only, with a test.

## Not touched
Handshake, queued OMNI build and Mothership jobs, switches, CODE gates, permissions, secrets, publish.

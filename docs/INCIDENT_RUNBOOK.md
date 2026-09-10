# INCIDENT RUNBOOK

## If WhatsApp disconnects
1. Check Baileys process.
2. Check auth state.
3. Check network.
4. Reconnect only after identifying reason.
5. Do not delete auth state blindly.

If other group members see “Waiting for this message”, restart with
`RESET_GROUP_SENDER_KEYS_ON_START=true`. The bot refreshes allowlisted group
metadata and invalidates only persisted sender-key memory so WhatsApp can
redistribute group keys without deleting the linked-device login.

If the problem continues, stop the bot and perform a controlled linked-device
re-pair: preserve a backup of `auth/`, confirm the exact `AUTH_DIR`, remove
only that active auth directory, and scan a new QR code. Never delete auth
state while another bot process is running. Send a plain text test message to
the group after re-pairing; existing “Waiting for this message” entries cannot
be repaired retroactively.

## If OCR becomes inaccurate
1. Stop automatic VALID decisions if accuracy is suspect.
2. Review recent fixtures.
3. Compare Tesseract output.
4. Compare Groq output.
5. Check image preprocessing.
6. Record regression.
7. Fix and rerun benchmark.

## If Groq fails
Configured behavior:
- preserve the local Tesseract extraction when available;
- expose a safe `AI_PROVIDER_UNAVAILABLE` fallback reason;
- keep the confidence score and do not use low-confidence OCR as Stripe
  evidence; the Stripe branch may still perform a separate caption-email
  lookup;
- log safe error;
- optionally retry according to policy after the local fallback.

If Tesseract itself fails, the OCR API returns a safe reason code such as
`TESSERACT_NOT_FOUND`, `TESSERACT_PROCESSING_FAILED`, or
`NO_TEXT_EXTRACTED`. Inspect the OCR service log for the matching processing
ID; never request or share API keys, WhatsApp auth state, or raw image data.

## If Stripe fails
Do not mark VALID.

Return ERROR/UNCLEAR according to configured business policy.

## If Google Sheets fails
Do not lose the processing result silently.
Queue/retry or mark logging failure.

## If duplicate detection fails
Prefer safety:
do not automatically approve ambiguous cases.

## If credentials leak
1. Stop affected integration.
2. Revoke/rotate credential.
3. Search git/history/logs.
4. Document incident.
5. Restore service with new credential.

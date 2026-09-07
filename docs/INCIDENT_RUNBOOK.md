# INCIDENT RUNBOOK

## If WhatsApp disconnects
1. Check Baileys process.
2. Check auth state.
3. Check network.
4. Reconnect only after identifying reason.
5. Do not delete auth state blindly.

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
- do not silently guess;
- mark processing as UNCLEAR or provider error;
- log safe error;
- optionally retry according to policy.

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

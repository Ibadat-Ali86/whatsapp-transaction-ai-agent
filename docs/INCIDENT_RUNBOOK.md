# INCIDENT RUNBOOK

## If WhatsApp disconnects
1. Check Baileys process.
2. Check auth state.
3. Check network.
4. Reconnect only after identifying reason.
5. Do not delete auth state blindly.

If the log contains `conflict`, `type=replaced`, or reason `440`, another
Baileys process/session is using the same WhatsApp linked-device state. The bot
now pauses automatic reconnect for this terminal conflict. Stop the other bot
process or remove the stale duplicate deployment, then start one bot instance.
Do not repeatedly restart both copies, because each connection can replace the
other and recreate the loop. The local `BOT_LOCK_PATH` also blocks accidental
second starts that use the same checkout.

If other group members see "Waiting for this message", restart with
`RESET_GROUP_SENDER_KEYS_ON_START=true`. The bot refreshes allowlisted group
metadata and invalidates only persisted sender-key memory so WhatsApp can
redistribute group keys without deleting the linked-device login.

If the problem continues, stop the bot and perform a controlled linked-device
re-pair: preserve a backup of `auth/`, confirm the exact `AUTH_DIR`, remove
only that active auth directory, and scan a new QR code. Never delete auth
state while another bot process is running. Send a plain text test message to
the group after re-pairing; existing "Waiting for this message" entries cannot
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
- Retry up to 3x with exponential backoff (1 s / 2 s / 4 s) on HTTP 429 or
  network timeout. This is the first line of defense against rate-limit bursts.
- After 3 failed attempts, preserve the local Tesseract extraction when
  available.
- Expose a safe AI_PROVIDER_UNAVAILABLE fallback reason.
- Keep the confidence score and do not use low-confidence OCR as Stripe
  evidence; the Stripe branch may still perform a separate caption-email lookup.
- Log safe error.

If Tesseract itself fails, the OCR API returns a safe reason code such as
TESSERACT_NOT_FOUND, TESSERACT_PROCESSING_FAILED, or NO_TEXT_EXTRACTED.
Inspect the OCR service log for the matching processing ID; never request or
share API keys, WhatsApp auth state, or raw image data.

Signs of a 429 storm (sustained Groq rate-limiting beyond 3 retries per call):
AI_PROVIDER_UNAVAILABLE appears in multiple consecutive processing IDs within
seconds. Mitigation: upgrade Groq tier or temporarily reduce concurrent workers.

## If Stripe fails
Do not mark VALID.
Return ERROR/UNCLEAR according to configured business policy.

## If Google Sheets fails
Do not lose the processing result silently.
Log the result to the local queue file. Retry the Sheets write on the next
processing cycle. Alert if Sheets write failure persists beyond 5 minutes.

## If verdict is UNCLEAR / STRIPE_PAGINATION_LIMIT
This verdict means Stripe search exhausted pagination before finding a unique
match. Common causes and fixes (all resolved as of 2026-11-04):

1. Missing or malformed caption email: caption_email=null causes Stripe to scan
   all charges. As of commit 4b28a1b, space/comma-separated TLD typos are
   healed automatically. If email was absent entirely, manual review is needed.

2. Missing payment date: If payment_date=null and no month/day pair exists,
   Stripe performs a 90-day broad scan. As of commit 4b28a1b, month/day pairs
   from Cash App receipts are synthesised to a full date using received_at.
   If date is still null, the image may be unreadable.

3. Cash App user-facing Receipt ID passed as transaction_id: As of commit
   90cb9af, the lookback recovery loop degrades gracefully on pagination limit.
   Day-bounded candidates are still evaluated. If this verdict appears post-fix,
   it means day-bounded candidates were also empty — see causes 1 and 2.

Diagnostic steps:
  # 1. Find the processing ID
  docker compose -f compose.production.yml logs --tail=500 bot | grep STRIPE_PAGINATION_LIMIT

  # 2. Check what fields OCR returned for that processing ID
  docker compose -f compose.production.yml exec bot node -e '
  const fs = require("fs");
  const q = JSON.parse(fs.readFileSync("/app/data/processing-queue.json","utf8"));
  const job = Object.values(q.jobs||{}).find(j=>j.processing_id==="REPLACE_ID");
  console.log(JSON.stringify(job?.result?.fields, null, 2));
  '

  # 3. Check OCR container logs for that ID
  docker compose -f compose.production.yml logs --tail=1000 ocr | grep "REPLACE_ID"

## If a valid Cash App payment is stuck in manual review (post 2026-11-04 fix)
Run the diagnostic above. Confirm payment_date and caption_email are both
populated. For Cash App charges in Stripe: receipt_email is NOT set;
customer is NOT set; billing_details.email IS the matching field.
If the verifier still fails, escalate with processing ID + Stripe charge ID.
Do not log charge amounts or customer PII in escalation tickets.

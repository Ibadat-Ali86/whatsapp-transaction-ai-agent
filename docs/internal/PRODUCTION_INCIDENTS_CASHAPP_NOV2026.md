# Internal production incident and recovery record — Cash App / OCR Fix Set (Nov 2026)

Handling: Internal operational record. Do not add credentials, customer identifiers,
screenshots, raw logs, server addresses, group identifiers, or unredacted Stripe data.

## Incident set: Cash App receipts systematically routed to manual review (2026-11-03/04)

Commits closing this set: 1c2dd9d, 243d5d8, 4b28a1b, 90cb9af

---

### Incident 1 — Groq 429 rate-limit causes silent Tesseract fallback
Symptom: OCR results had empty/low-confidence fields despite legible image. Verdicts: UNCLEAR or UNVERIFIED.
Root cause: No retry logic in GroqVisionProvider. First 429 triggered Tesseract fallback. Tesseract confidence was low.
Fix: 3-attempt exponential backoff (1s/2s/4s). HTTP 429 and network timeouts classified retryable. After 3 failures, Tesseract fallback still engages.
Code: 243d5d8 — src/ai/groq_provider.py
Follow-up: Alert if AI_PROVIDER_RETRIED count exceeds 10/hour.

### Incident 2 — Non-media messages triggered infinite OCR queue retry
Symptom: Queue depth grew unexpectedly with no image activity.
Root cause: Message type not checked before queuing.
Fix: Non-image messages short-circuit before OCR queue insertion.
Code: 1c2dd9d — src/ocr/engine.py
Follow-up: Alert if queue depth exceeds 20 without image spike.

### Incident 3 — Caption email with space/comma before TLD produces null email anchor
Symptom: caption "daisyybee0101@gmail com" → caption_email=null → unbounded Stripe scan → STRIPE_PAGINATION_LIMIT.
Root cause: RFC-5322 regex correctly rejected malformed email. No pre-normalisation existed.
Fix: Normalisation regex added to normalizeCaptionEmail() healing space/comma-separated TLDs.
Code: 4b28a1b — src/whatsapp/caption-email.js
Follow-up: Log CAPTION_EMAIL_HEALED events. Extend TLD allowlist as needed; do not use \w+.

### Incident 4 — Cash App month/day receipt date produces unbounded 90-day Stripe scan
Symptom: OCR returned payment_month=11, payment_day=3, payment_date=null. has_bounded_receipt_window=false. 90-day scan hit STRIPE_PAGINATION_LIMIT.
Root cause: Neither JS bot nor Python verifier synthesised a full date from month/day pair.
Fix: Both layers now synthesise payment_date from (payment_month, payment_day, received_at.year) with year-rollback guard.
Cash App receipt date format note: "Tue, Nov 03" — no year as of 2026-11-03.
Code: 4b28a1b — src/whatsapp/direct-verification-client.js, src/verification/stripe_verifier.py
Follow-up: Log PAYMENT_DATE_INFERRED. Test year-rollback in January integration tests.

### Incident 5 — Cash App user-facing Receipt ID exhausts Stripe lookback recovery
Symptom: Payment with billing_details.email in Stripe still routed to manual review. Verdict: UNCLEAR/STRIPE_PAGINATION_LIMIT.
Root cause: OCR extracted user-facing Payment Identifier (e.g. DVWJ361R0) as evidence.transaction_id. Recovery loop scanned 90 days x 100 charges for a matching cashapp.transaction_id — these are different identifiers. Loop exhausted pagination and overwrote the valid day-bounded match.
Cash App Stripe charge profile (confirmed 2026-11-03):
  - receipt_email: NOT SET
  - customer: NOT SET
  - billing_details.email: SET — use this for matching
  - cashapp.cashtag: user handle (e.g. $mercedesarriaga8) — not an email
  - cashapp.transaction_id: Stripe-internal opaque ID, NOT the user-facing receipt identifier
Fix: _charges_for_lookback() at ~line 1633 wrapped in try/except StripePaginationLimitError. On hit: recovery_charges=[], fall through. Day-bounded candidates scored normally.
Verification: Live 2026-11-03: TIMEZONE_BOUNDARY_SINGLE_MATCH, charge py_3UXphrAPeUuGSf6Z1pRarKvt. VALID confirmed.
Code: 90cb9af — src/verification/stripe_verifier.py

---

## Manual reconciliations performed 2026-11-03

| Processing ID | Amount | Stripe Charge ID | Manual Verdict |
|---|---|---|---|
| wa-20261103235014-131e8e38 | $26.75 | py_3UXpeuAPeUuGSf6Z0FpgS6km | VALID |
| wa-20261104002651-2517b70a | $22.00 | py_3UXphrAPeUuGSf6Z1pRarKvt | VALID |

Stored in bind-mounted /app/data/duplicate-store.json. Persist across container restarts.
Will not persist if host volume is deleted.

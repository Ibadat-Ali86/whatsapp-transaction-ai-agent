## [Unreleased] — 2026-11-04

### Fixed

#### Groq 429 / Timeout Silent Fallback (commit `243d5d8`)
- **File**: `src/ai/groq_provider.py`
- Added 3-attempt exponential backoff retry (delays 1 s / 2 s / 4 s). Both HTTP 429 and network-layer timeouts classified as retryable via `_is_retryable()`.
- Before this fix a single 429 caused silent fall-through to Tesseract, producing low-quality fields and downstream UNCLEAR verdicts.

#### OCR `payment_method_type` Schema Hardening + Non-Media Infinite Retries (commit `1c2dd9d`)
- **File**: `src/ocr/engine.py`
- Coerced `payment_method_type` to strict enum set; non-media messages now short-circuit before queue entry, stopping an infinite retry loop.

#### Caption Email TLD Typo Healing (commit `4b28a1b`)
- **File**: `src/whatsapp/caption-email.js`, function `normalizeCaptionEmail()`
- Heals `gmail com` and `gmail,com` before RFC-5322 validation. With `caption_email=null`, Stripe searches were unrestricted and hit pagination limits.

#### Month/Day Date Inference from `received_at` (commit `4b28a1b`)
- **Files**: `src/whatsapp/direct-verification-client.js`, `src/verification/stripe_verifier.py`
- Synthesises full `payment_date` from `(payment_month, payment_day, received_at.year)` with year-rollback guard. Cash App receipts display only `Tue, Nov 03` — without this, `has_bounded_receipt_window=false` triggered 90-day broad Stripe scans.

#### Cash App User-Facing Receipt ID Exhausts 90-Day Pagination Limit (commit `90cb9af`)
- **File**: `src/verification/stripe_verifier.py` (secondary recovery loop ~line 1633)
- Cash App user-facing Payment Identifier (e.g. `DVWJ361R0`) is NOT Stripe internal `transaction_id`. Recovery loop wrapped in `try/except StripePaginationLimitError`; on hit sets `recovery_charges=[]` and falls through to day-bounded candidates.
- Verified live: `TIMEZONE_BOUNDARY_SINGLE_MATCH py_3UXphrAPeUuGSf6Z1pRarKvt` ✓

---

# CHANGELOG

## 0.3.5 — Caption identity and Stripe canonical fields
- Use the WhatsApp caption email as the primary lookup identity in replies and
  the n8n Stripe branch.
- Support safe email-only Stripe test-mode lookup with canonical transaction
  amount, date, time, name, and status.
- Keep ambiguous and caption/OCR-conflict cases non-approving.

## 0.3.4 — OCR provider resilience
- Preserve Tesseract results when the optional Groq/Gemini fallback is
  unavailable or rate-limited.
- Added safe OCR reason codes for genuine Tesseract failures.
- Prevented low-confidence OCR fallback results from entering the n8n Stripe
  verification branch.

## 0.3.3 — Stripe verifier runtime acceptance
- Exercised the real FastAPI Stripe verification endpoint against a disposable
  read-only Stripe-compatible fixture.
- Confirmed unauthorized requests return `401` and one exact Cash App match
  returns `VALID` without exposing credentials.

## 0.3.2 — n8n runtime acceptance hardening
- Added structured HTTP 400 responses for invalid v2 webhook events.
- Verified the v2 export imports with distinct webhook and Stripe credentials.
- Verified authenticated OCR, duplicate suppression, and caption/OCR conflict
  behavior in an isolated n8n 1.100.1 runtime.

## 0.3.1 — Workflow safety hardening
- Added bounded base64 input validation to both versioned n8n workflows.
- Added v2 workflow-level duplicate protection and safe duplicate responses.
- Disabled n8n success/error execution-data retention for image payloads.

## 0.3.0 — Gated Stripe verification workflow
- Added the optional n8n v2 OCR-to-Stripe test-mode route.
- Added server-side verification result formatting in WhatsApp replies.
- Added workflow structure and secret-boundary regression tests.

## 0.2.0 — Phase 1 completion and Phase 2 Step 1
- Improved OCR candidate selection for compact phone screenshots.
- Added email-caption validation and safe WhatsApp rejection messaging.
- Added bounded message-id idempotency protection.
- Added authenticated n8n webhook client with timeout and retry handling.
- Added versioned n8n workflow export for local OCR routing.
- Added Phase 2 analysis and local acceptance runbook.

## 0.1.0 — Documentation baseline
- Added controlled AI-agent documentation package.
- Added PRD.
- Added system architecture.
- Added technical specification.
- Added phased build plan.
- Added OCR specification.
- Added n8n specification.
- Added security and privacy controls.
- Added testing strategy.
- Added logging/audit specification.
- Added change-control rules.
- Added persistent project memory.
- Added progress tracker.
- Added release and incident runbooks.
- Added Groq development provider decision.
- Added Gemini future-provider decision.
- Added local-first/no-DigitalOcean-at-start decision.

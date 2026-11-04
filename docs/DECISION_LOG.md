# ARCHITECTURE DECISION LOG

## ADR-001 — Local-first development
Decision:
Build and test locally before DigitalOcean.

Reason:
Lower cost, safer experimentation, easier debugging.

Status:
Accepted.

## ADR-002 — Google Sheets as planned data layer
Decision:
Use Google Sheets instead of PostgreSQL for the operational logging/database requirement.

Reason:
Matches current project scope and simplifies early deployment.

Status:
Accepted.

## ADR-003 — Provider abstraction
Decision:
AI vision provider must be configurable.

Reason:
Groq is used for development; Gemini is planned later.

Status:
Accepted.

## ADR-004 — Groq during development
Decision:
Use Groq Vision for development/testing fallback.

Reason:
Allows vision-model testing without using the future production Gemini credential.

Status:
Accepted.

## ADR-005 — Tesseract first
Decision:
Run local Tesseract before cloud AI.

Reason:
Lower cost, local processing, fast baseline.

Status:
Accepted.

## ADR-006 — n8n remains final orchestration layer
Decision:
Use n8n in final architecture, but introduce it after Phase 1.

Reason:
Avoid debugging multiple integration layers simultaneously.

Status:
Accepted.

## ADR-007 — Minute-only verification requires validation
Decision:
Retain as documented baseline only until collision testing proves it safe.

Reason:
Minute-only matching can produce multiple candidates.

Status:
Accepted with production-review requirement.

## ADR-010 — Groq 429 retry with exponential backoff inside the provider
Decision: 3-attempt retry (1 s / 2 s / 4 s) in `GroqVisionProvider.extract_from_image()`. HTTP 429 and network timeouts are retryable. After exhaustion, AIProviderError re-raised; Tesseract fallback still engages.
Rationale: First 429 caused silent Tesseract fallback → low-quality fields → UNCLEAR verdicts → manual review. Backoff absorbs burst rate-limits within OCR request timeout.
Rejected: Retry at engine layer — violates provider abstraction (ADR-003).
Consequences: 429 errors survivable. Max +7 s latency per call. Persistent storm still falls back to Tesseract.
Commit: 243d5d8 | Status: Accepted.

## ADR-011 — Caption email TLD typo normalisation before validation
Decision: In `normalizeCaptionEmail()`, apply `/@([a-zA-Z0-9-]+)[\s,]+(com|net|org|edu|gov|io|co|ai|me)\b/ → @$1.$2` before the RFC-5322 regex.
Rationale: Space/comma-separated TLDs in WhatsApp captions set `caption_email=null`, causing unbounded Stripe scans and pagination overflow. TLD allowlist prevents over-healing.
Rejected: Levenshtein fuzzy matching at Stripe layer — false-positive risk in payment-critical path.
Consequences: Healed emails enable bounded searches. TLD allowlist requires maintenance as new TLDs appear.
Commit: 4b28a1b | Status: Accepted.

## ADR-012 — Month/day receipt date inference from `received_at`
Decision: When `payment_date=null` but `payment_month`+`payment_day` are set, synthesise full ISO date from `received_at.year`. Year-rollback guard: if inferred date > received_at + 1 day, use year-1. Implemented in both JS bot and Python verifier.
Rationale: Cash App shows `Tue, Nov 03` without year. Without `payment_date`, broad 90-day scans exhaust pagination. `received_at` is server-side and cannot be spoofed.
Rejected: Python-only synthesis — JS also uses `payment_date` for `stripe_search_inputs`; null at that layer discards evidence before Python can recover it.
Consequences: Day-bounded searches activate for Cash App receipts. Year-rollback handles Jan 01 edge correctly.
Commit: 4b28a1b | Status: Accepted.

## ADR-013 — Isolate Cash App user-facing receipt ID from Stripe lookback recovery
Decision: Wrap `_charges_for_lookback()` at ~line 1633 in `try/except StripePaginationLimitError`. On hit: `recovery_charges=[]`, fall through to day-bounded candidate scoring.
Rationale: Cash App user-facing Payment Identifier (e.g. DVWJ361R0) != Stripe's internal `payment_method_details.cashapp.transaction_id`. Recovery loop always exhausted 90-day × 100-charge/page pagination, raising StripePaginationLimitError that overwrote valid day-bounded match. Cash App Stripe charge profile: `receipt_email`=null, `customer`=null, `billing_details.email`=SET, `cashtag`=not an email.
Rejected: Conditional bypass for Cash App payment type — payment method type not reliably detected at that point; defensive exception boundary is safer.
Consequences: Cash App payments auto-verified via TIMEZONE_BOUNDARY_SINGLE_MATCH when email+date are present. Recovery loop still runs; degrades gracefully on overflow.
Commit: 90cb9af | Status: Accepted.

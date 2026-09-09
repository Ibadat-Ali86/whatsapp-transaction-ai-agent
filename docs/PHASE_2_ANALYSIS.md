# Phase 2 Analysis — n8n Integration

## Scope

Phase 2 introduces n8n as a local orchestration boundary between the Baileys
transport and the OCR service. A gated server-side Stripe test-mode verifier
is also available as the next integration boundary, while formal Stripe
acceptance, duplicate detection, Google Sheets, Telegram, and production
deployment remain later phase gates in `docs/PHASE_PLAN.md`.

## Required flow

```text
WhatsApp image + email caption
  -> Baileys allowlist and input validation
  -> authenticated n8n webhook
  -> event validation and idempotency
  -> OCR service
  -> optional Stripe test verifier
  -> n8n response
  -> Baileys reply
```

## Security and reliability requirements

- Accept messages only from the configured WhatsApp group allowlist.
- Require a single syntactically valid email image caption.
- Authenticate the webhook with a secret header; never export the value.
- Bound webhook timeouts and retry only network/5xx/429 failures.
- Use `source + message_id` as the idempotency key.
- Do not log or retain raw base64 payloads in application logs or successful
  n8n executions.
- Keep the local webhook private; do not expose port 5678 to the internet.
- Treat the caption as a lookup hint, not payment proof. OCR and later Stripe
  evidence must still be compared deterministically.

## Implementation checkpoints

### Step 1 — Contract and authenticated OCR routing (implemented)

- Added the versioned n8n workflow export.
- Added a Baileys n8n client with timeout, safe errors, and bounded retry.
- Added email-caption validation and canonicalization.
- Added message idempotency protection in the Baileys handler.
- Kept the direct OCR path as the default so Phase 1 remains locally testable.

### Step 2 — Local runtime acceptance (implemented)

- Validated the export with an isolated n8n `1.100.1` runtime and a fresh
  SQLite database.
- Imported separate webhook and verifier header credentials without exporting
  their values, then activated v2.
- Ran authenticated webhook tests with a synthetic OCR fixture.
- Confirmed invalid tokens return `403`, invalid captions return structured
  `400` rejection responses, valid OCR-only requests return a non-approving
  `STRIPE_DISABLED` result, and repeated message IDs return `DUPLICATE`
  without re-running OCR.
- The live `N8N_ENABLED=true` Baileys -> n8n -> OCR -> Baileys path remains a
  user-controlled WhatsApp acceptance step.

Repeatable synthetic adapter smoke test:

```bash
N8N_BASE_URL=http://127.0.0.1:5678 \\
N8N_WEBHOOK_TOKEN="$N8N_WEBHOOK_TOKEN" \\
npm run smoke:n8n
```

This exercises the real message handler and n8n client with
`tests/fixtures/ocr/synthetic_clear_01.png`; it does not connect to WhatsApp.

### Step 2a — Server-side Stripe test verifier (implemented, gated)

- Added `POST /api/v1/verification/stripe` to the Python service.
- Accepts structured evidence; Stripe credentials are loaded from server
  configuration and never from a request.
- Requires a separate `X-Internal-Service-Token` before any Stripe call.
- Uses read-only customer and charge list endpoints with pagination.
- Requires test mode, exact integer cents, normalized email, date/minute, and
  a single matching charge. Ambiguity returns `UNCLEAR`.
- Emits a safe audit event with a one-way email hash and no authorization data.

The endpoint is intentionally disabled by default and has not yet been
enabled by default. The v2 n8n export now contains the optional connection;
v1 remains the rollback-safe OCR-only workflow.

### Step 2b — n8n OCR-to-Stripe route (implemented, gated)

- Added `whatsapp-screenshot-processor_v2_20260910.json`.
- Preserves OCR-only behavior when `STRIPE_VERIFICATION_ENABLED=false`.
- Calls the internal verifier only when the event gate and required OCR
  evidence are present.
- Rejects caption/OCR email conflicts without calling Stripe.
- Applies a bounded image-payload check and a 24-hour `source:message_id`
  duplicate guard before OCR.
- Stores the internal verifier token only in an n8n credential reference; no
  token or Stripe key is present in the export.
- Disables n8n success/error execution data retention so raw image base64 is
  not retained by the workflow.
- Returns the verifier result alongside OCR data so Baileys can display the
  audit-safe result.
- The OCR-to-Stripe conflict branch was exercised locally and returned
  `CAPTION_OCR_EMAIL_CONFLICT` without calling Stripe.

#### Local verifier test

Use only a Stripe test-mode key and a synthetic/test transaction. Configure
`STRIPE_ENABLED=true`, `STRIPE_MODE=test`, `STRIPE_SERVICE_TOKEN`, and the
other `STRIPE_*` variables in the local environment, then start the OCR
service. Call the internal endpoint with the token header:

```bash
curl --fail-with-body -X POST http://127.0.0.1:8000/api/v1/verification/stripe \
  -H "Content-Type: application/json" \
  -H "X-Internal-Service-Token: ${STRIPE_SERVICE_TOKEN}" \
  --data '{
    "processing_id": "wa-test-stripe-001",
    "email": "testuser@example.com",
    "amount_cents": 2500,
    "payment_date": "2026-09-09",
    "minutes": 31,
    "payment_hour": 14,
    "currency": "usd",
    "payment_method_type": "cashapp"
  }'
```

Expected outcomes are `VALID` only for one exact Stripe match;
`NO_MATCH`/`UNCLEAR` for no match; `AMBIGUOUS`/`UNCLEAR` for collisions; and
`ERROR` for configuration or Stripe API failures. A missing or incorrect
internal token must return HTTP 401, and Stripe verification must remain
disabled outside this controlled test.

### Step 3 — Failure and recovery acceptance (partially implemented)

- Invalid/missing caption returns a structured `400` validation error.
- Invalid token is rejected before OCR.
- Duplicate message IDs do not re-run OCR.
- Caption/OCR email conflict is non-approving and does not call Stripe.
- OCR timeout/5xx produces a safe retryable workflow error (pending live
  failure injection).
- n8n unavailable produces a safe WhatsApp error without leaking internals
  (pending live Baileys acceptance).
- Stripe verifier unavailable produces a controlled non-approving error
  (pending live gated-branch acceptance).

## Unknowns requiring live validation

- Container networking may require replacing `localhost` in the OCR node.
- The final retention policy for failed n8n executions needs client approval.
- The export was verified against n8n `1.100.1`; other n8n versions should be
  re-imported and smoke-tested before activation.
- Stripe matching is implemented as a gated test-mode service boundary; live
  Stripe fixtures and formal Phase 4 acceptance are still pending.

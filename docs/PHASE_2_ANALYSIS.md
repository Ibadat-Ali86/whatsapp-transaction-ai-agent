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

### Step 2 — Local runtime acceptance (pending)

- Install or start local n8n.
- Import the workflow and configure its header credential.
- Run an authenticated webhook test with a synthetic fixture.
- Enable `N8N_ENABLED=true` and run Baileys -> n8n -> OCR -> Baileys.

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
connected to the exported n8n workflow. That connection follows local n8n
acceptance and Stripe test fixtures.

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

### Step 3 — Failure and recovery acceptance (pending)

- Invalid/missing caption returns a safe validation error.
- Invalid token is rejected before OCR.
- Duplicate message IDs do not re-run OCR.
- OCR timeout/5xx produces a safe retryable workflow error.
- n8n unavailable produces a safe WhatsApp error without leaking internals.

## Unknowns requiring live validation

- The installed n8n version and exact import behavior are not available on this
  development machine.
- Container networking may require replacing `localhost` in the OCR node.
- The final retention policy for failed n8n executions needs client approval.
- Stripe matching is implemented as a gated test-mode service boundary; live
  Stripe fixtures and formal Phase 4 acceptance are still pending.

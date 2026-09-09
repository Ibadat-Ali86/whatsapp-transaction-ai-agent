# Phase 2 Analysis — n8n Integration

## Scope

Phase 2 introduces n8n as a local orchestration boundary between the Baileys
transport and the OCR service. It does not implement Stripe verification,
duplicate detection, Google Sheets, Telegram, or production deployment; those
remain later phases in `docs/PHASE_PLAN.md`.

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
- Stripe matching remains intentionally unimplemented until Phase 4 and must
  use test mode first.

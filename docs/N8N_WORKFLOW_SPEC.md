# n8n WORKFLOW SPECIFICATION

## Purpose
n8n is the orchestration layer of the final system.

n8n should be introduced after the Phase 1 WhatsApp/OCR path is stable.

## Development workflow

Webhook
-> validate request
-> assign processing ID
-> hash image
-> duplicate check
-> OCR service
-> confidence/fallback decision
-> field validation
-> transaction duplicate check
-> Stripe verification
-> verdict
-> Google Sheets log
-> Telegram alert if needed
-> response to Baileys

Phase 2 Step 1 contract:
- The Baileys adapter sends `POST /webhook/whatsapp-screenshot`.
- The request must include `message_id`, `group_id`, `sender_jid`,
  `processing_id`, `caption_email`, and the image `{mime_type, base64}`.
- `caption_email` is optional. When present and syntactically valid it is the
  preferred lookup hint, not proof that a payment is valid. Missing, malformed,
  or stale captions are not treated as payment proof or a processing blocker.
- The adapter sends an `X-Webhook-Token` header when configured. The n8n
  webhook must use header authentication; token values are never exported.
- The webhook response is returned to Baileys as the OCR/workflow result.
- Baileys reacts to valid results with `✅`. When the caption is missing and
  Stripe recovers a valid transaction, Baileys additionally sends a detailed
  quoted reply showing the canonical Stripe email and transaction details so
  the group can audit the recovered identity. Captioned valid results remain
  reaction-only; duplicate results retain their explanatory text reply.
- The v2 export routes caption/OCR identity plus deterministic amount/date/time
  evidence to the internal Stripe verifier when `stripe_verification_enabled`
  is true. Stripe remains the canonical source for amount, date, time, name,
  customer email, and status. A missing/stale caption can recover the email
  only from one unambiguous eligible charge; otherwise the verdict is UNCLEAR.
  Textual receipt dates such as `Aug 14` are sent as `payment_month` and
  `payment_day`. For multi-group operation, leave
  `STRIPE_SCREENSHOT_TIMEZONE` empty so receipt hours from different local
  zones cannot cause a false rejection; amount, date/month-day, and minute
  constraints remain fail-closed filters. Configure that timezone only when
  all receipts are known to use one clock.
  The v1 export remains OCR-only.
- Message ID plus source is the idempotency key. Baileys claims the key before
  dispatch; v2 also applies a 24-hour active-workflow guard and returns a safe
  duplicate response without re-running OCR. A shared store is required for
  clustered n8n deployments.

## Webhook security

Use authentication for non-local production webhook endpoints.

Supported approaches may include:
- header authentication;
- basic authentication;
- JWT;
- IP allowlisting where appropriate.

Never expose an unauthenticated production webhook carrying payment data.

## Test vs production

Use n8n test webhook during workflow development.

Use production webhook only after workflow is published and acceptance-tested.

## Local development

n8n can run locally.

Do not expose port 5678 to the public internet during local development.

## Workflow versioning

Export workflows as JSON into:

n8n/workflows/

Every workflow export must have:
- version;
- date;
- change description.

Do not store secret credential values inside exported workflow files.

Disable successful and failed execution data retention when the workflow
carries raw image base64.

## Failure handling

Every external node should define:
- timeout;
- retry policy;
- failure branch;
- safe error message.

## Idempotency

The workflow must avoid processing the same WhatsApp message twice.

Use message_id + source identifier as the processing idempotency key.

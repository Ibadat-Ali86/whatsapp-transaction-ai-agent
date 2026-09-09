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
- `caption_email` must be a single syntactically valid email. It is an input
  identifier, not proof that a payment is valid.
- The adapter sends an `X-Webhook-Token` header when configured. The n8n
  webhook must use header authentication; token values are never exported.
- The webhook response is returned to Baileys as the OCR/workflow result.
- Message ID plus source is the idempotency key. Duplicate deliveries must
  return the existing result or be skipped without reprocessing the image.

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

## Failure handling

Every external node should define:
- timeout;
- retry policy;
- failure branch;
- safe error message.

## Idempotency

The workflow must avoid processing the same WhatsApp message twice.

Use message_id + source identifier as the processing idempotency key.

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

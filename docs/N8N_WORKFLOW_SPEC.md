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
- `caption_email` is optional. The WhatsApp adapter extracts one email token
  from a caption even when additional text is present; when present it is the
  preferred lookup hint, not proof that a payment is valid. Missing, malformed,
  or stale captions are not treated as payment proof or a processing blocker.
- The adapter sends an `X-Webhook-Token` header when configured. The n8n
  webhook must use header authentication; token values are never exported.
- The webhook response is returned to Baileys as the OCR/workflow result.
- Baileys reacts to valid results with `✅`. When the caption is missing or
  Stripe corrects a mistyped caption, Baileys additionally sends a detailed
  quoted reply showing the canonical Stripe email and transaction details so
  the group can audit the recovered identity. Other captioned valid results
  remain reaction-only; duplicate results retain their explanatory text reply.
- The v2 export routes caption/OCR identity plus deterministic amount/date/time
  evidence and an exact OCR payment identifier to the internal Stripe verifier
  when `stripe_verification_enabled` is true. Stripe remains the canonical
  source for amount, date, time, name, customer email, and status. A
  missing/stale caption can recover the email from one unambiguous eligible
  charge. The workflow preserves a distinct OCR-visible email in
  `email_candidates` alongside the caption hint so Stripe can choose the
  canonical identity. An exact transaction identifier can disambiguate
  simultaneous same-amount payments and recover from a wrong caption email.
  The verifier first applies all available receipt constraints (date or
  month/day, minute, and configured receipt hour) even on the customer-scoped
  email path. It only falls back to timezone-tolerant minute matching and then
  identity-only matching when the stricter pass has no result. This prevents
  same-email/same-amount charges from being reported as ambiguous when the
  receipt clock uniquely identifies one charge, while preserving fail-closed
  behavior when multiple charges genuinely remain eligible. Identifier
  collisions remain UNCLEAR; if OCR produces an identifier that does not
  resolve, the verifier falls back to the normal safe email/evidence path
  rather than treating the OCR hint alone as a rejection.
  The Baileys event also carries a bounded list of previously claimed Stripe
  charge IDs. When several otherwise eligible Stripe charges match, the
  verifier may select a charge only when exactly one candidate is still fresh;
  if two or more fresh candidates remain, it stays UNCLEAR. A sole previously
  claimed candidate is preserved so the adapter can classify the submission as
  a duplicate transaction rather than incorrectly approving it as new.
  The direct OCR-service path receives the same list when n8n is disabled, so
  multi-match behavior is identical in both supported deployment modes.
  Stripe `description` is fetched and returned with the unique matched
  transaction; it is not expected in the current receipt screenshots and is
  never fabricated by the AI extractor. It can disambiguate only when the
  submitted evidence explicitly contains the same description.
  Textual receipt dates such as `Aug 14` are sent as `payment_month` and
  `payment_day`; when `received_at` and the configured Stripe timezone make
  the year unambiguous, v2 also derives a bounded `payment_date` for the
  lookup. A receipt saying `Today` is kept as relative evidence and is not
  converted into a guessed account-timezone date. The verifier instead uses a
  bounded window around `received_at`, then applies the exact amount, minute,
  status, currency, method, and identity checks. For multi-group operation, leave
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

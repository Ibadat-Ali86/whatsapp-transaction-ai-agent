# WhatsApp Screenshot Processor v2

- Version: 2
- Date: 2026-09-15
- Change: Docker-network URLs plus relative-receipt and evidence recovery safeguards

## What changed

The v2 workflow keeps the authenticated webhook and OCR path from v1, then
adds a bounded validation/idempotency layer and a gated branch:

```text
validate -> idempotency guard -> OCR -> Stripe gate -> Stripe verifier -> response
                                      \-> OCR-only response when disabled
```

The Stripe branch runs when the Baileys event contains
`stripe_verification_enabled=true`. The caption email is optional and is a
preferred lookup hint. OCR amount/date/time evidence is passed to Stripe as
bounded recovery evidence when the caption is missing, malformed, or does not
match. Textual dates such as `Aug 14` become a month/day constraint. Stripe
supplies canonical amount, date, time, customer email, name, and status;
recovery is approved only for one eligible charge. A receipt showing `Today`
is passed as relative evidence with the WhatsApp receive timestamp instead of
being assigned a guessed Stripe-account date. Ambiguous, insufficient, and
conflicting matches remain non-approving.

For groups that may contain receipts from different time zones, leave
`STRIPE_SCREENSHOT_TIMEZONE` empty. The verifier then ignores the screenshot
hour as a hard constraint while retaining amount, date/month-day, and minute
filters. Set it to an IANA timezone such as `America/Chicago` only when every
receipt uses that clock. The canonical response time continues to use
`STRIPE_TIMEZONE`.

Malformed event identity or image input is rejected with a structured HTTP
`400` response before idempotency or OCR processing. A malformed caption is
discarded as an identity hint and continues through OCR/Stripe recovery.

## Configure safely

1. Import v2 only after v1 local OCR acceptance, and keep it inactive during
   import.
2. Keep the existing webhook header credential.
3. Create the `OCR service Stripe verifier auth` header credential with header
   name `X-Internal-Service-Token` and the same value as the Python service's
   `STRIPE_SERVICE_TOKEN`. The value is intentionally absent from this export.
4. Configure the OCR service with `STRIPE_ENABLED=true`, a mode/key pair that
   matches (`STRIPE_MODE=test` with `sk_test_`/`rk_test_`, or explicitly
   approved `STRIPE_MODE=live` with `sk_live_`/`rk_live_`), and the configured
   timezone. Leave `STRIPE_SCREENSHOT_TIMEZONE` empty for multi-timezone groups,
   or set it to the known receipt timezone for stricter hour matching.
5. Set `STRIPE_VERIFICATION_ENABLED=true` in the Baileys process only when
   Stripe verification is intentionally enabled. Keep it false for OCR-only
   operation.
6. This Docker export already targets the Compose service name `ocr:8000` for
   both OCR and Stripe verification requests. Do not change these URLs unless
   the service name or network architecture changes.
7. The workflow keeps a 24-hour `source:message_id` guard in active-workflow
   static data and returns a non-approving duplicate response. Baileys remains
   the primary idempotency boundary; clustered n8n deployments should replace
   the static-data guard with a shared store before production use.

## Local acceptance evidence

The committed export was imported and activated in an isolated n8n `1.100.1`
runtime with a fresh SQLite database. A synthetic receipt fixture produced an
OCR response with `STRIPE_DISABLED`, a repeated message ID produced a safe
`DUPLICATE` response, an invalid token returned `403`, and an invalid caption
returned `400` with `INVALID_CAPTION_EMAIL`.

## Safety boundary

n8n never receives the Stripe secret key. It sends structured evidence to the
local authenticated verifier, which performs read-only, paginated Stripe
lookups and returns `VALID` only for one exact match. Final verdict policy,
Sheets logging, and Telegram alerts remain later gates. Successful and failed
n8n execution data are disabled in the export so image base64 is not retained
by the workflow.

# ENVIRONMENT CONFIGURATION

Create .env locally from .env.example.

## Development

AI_PROVIDER=groq

GROQ_API_KEY=
GROQ_VISION_MODEL=

GEMINI_API_KEY=
GEMINI_VISION_MODEL=

OCR_CONFIDENCE_THRESHOLD=0.85

N8N_BASE_URL=http://localhost:5678
N8N_WEBHOOK_PATH=/webhook/whatsapp-screenshot
N8N_HEALTH_TIMEOUT_MS=5000

LOG_LEVEL=INFO

`STRIPE_VERIFICATION_ENABLED=true` is required in the Baileys process when the
v2 n8n workflow should call Stripe. It defaults to false and does not expose
the Stripe secret.

`BOT_REACTIONS_ENABLED=true` enables reaction-first results. Clear valid and
failed/unclear results react to the original screenshot. Captionless valid
results also send a detailed reply containing the canonical Stripe-recovered
email so the group can see which customer was matched. Duplicate results
remain text replies so the bot can explain the original processing record.
`REQUIRE_EMAIL_CAPTION` is retained for compatibility but should be `false`:
the caption email is preferred evidence, not a prerequisite. Missing or
incorrect captions are recovered only from deterministic OCR evidence and one
eligible Stripe match; ambiguous evidence remains unconfirmed.

## WhatsApp group access

WHATSAPP_ALLOWED_GROUP_JIDS=1234567890-1234567890@g.us,1234567890-9876543210@g.us

- This is an exact, comma-separated allowlist of group JIDs.
- Direct chats and all other groups are ignored before application processing.
- An empty allowlist is fail-closed: the bot can authenticate, but it will not process or reply to messages.
- `WHATSAPP_TEST_GROUP_JID` remains supported as a legacy single-group setting.
- The project is pinned to Baileys `7.0.0-rc14`; stop any old bot process before restarting after dependency changes.

## Stripe read-only verification

The verifier is server-side and read-only. It only performs paginated GET
requests for Customers and Charges. Keep the Stripe secret only in the OCR
service environment; n8n receives only `STRIPE_SERVICE_TOKEN`.

STRIPE_ENABLED=false
STRIPE_SECRET_KEY=
STRIPE_SERVICE_TOKEN=
# Must match the key prefix. Use test for development and live only for an
# explicitly approved production/live-data environment.
STRIPE_MODE=test
STRIPE_API_BASE_URL=https://api.stripe.com
STRIPE_API_VERSION=
STRIPE_TIMEOUT_SECONDS=15
STRIPE_TIMEZONE=UTC
# Optional timezone printed by payment receipts, e.g. America/Chicago.
# Leave empty for multi-group/multi-timezone operation; screenshot hour is then
# diagnostic only and cannot reject a match. Minutes and date remain filters.
STRIPE_SCREENSHOT_TIMEZONE=
STRIPE_MAX_PAGES=10
STRIPE_LOOKBACK_DAYS=90
STRIPE_ALLOWED_PAYMENT_METHOD_TYPE=cashapp

When `STRIPE_MODE=test`, use standard `sk_test_` or restricted `rk_test_`
keys. For an explicitly approved live environment, set `STRIPE_MODE=live` and
use `sk_live_` or restricted `rk_live_`. Publishable `pk_` keys are never
accepted because this is a server-side API integration.

## Duplicate detection

The WhatsApp adapter persists duplicate metadata in
`DUPLICATE_STORE_PATH` (default `data/duplicate-store.json`) and never stores
the screenshot itself. `DUPLICATE_RETENTION_DAYS` controls metadata retention
and defaults to 90 days. Exact resends are detected by SHA-256 across all
allowlisted groups and bot restarts. Recompressed/resized copies are compared
with pHash only when the caption identity and OCR amount also agree. A
uniquely matched Stripe charge ID is independently claimed so the same
payment is marked duplicate even when the image changes.

The file store is safe for one bot process handling many groups. If production
uses multiple bot processes or hosts, replace it with a shared transactional
store before rollout; otherwise two processes can claim the same image or
Stripe charge concurrently.

For this verifier, restricted keys must have read-only access to Customers and
Charges. Never grant write permissions. The internal service token is required
on verification requests and must be configured in the n8n credential/request
header. Never place either secret in Baileys, n8n workflow exports, logs, or
WhatsApp messages.

Live mode reads real customer and payment data. Before enabling it, use a
dedicated allowlisted WhatsApp group, confirm the account and key are correct,
and keep the live secret out of source control and screenshots.

## Future Google Sheets

GOOGLE_SHEETS_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=

## Future Telegram

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

## Rules

- .env is never committed.
- .env.example contains names only.
- Do not put real credentials in documentation.
- AI provider keys are optional until that provider is active.

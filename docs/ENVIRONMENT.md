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

LOG_LEVEL=INFO

## WhatsApp group access

WHATSAPP_ALLOWED_GROUP_JIDS=1234567890-1234567890@g.us,1234567890-9876543210@g.us

- This is an exact, comma-separated allowlist of group JIDs.
- Direct chats and all other groups are ignored before application processing.
- An empty allowlist is fail-closed: the bot can authenticate, but it will not process or reply to messages.
- `WHATSAPP_TEST_GROUP_JID` remains supported as a legacy single-group setting.
- The project is pinned to Baileys `7.0.0-rc14`; stop any old bot process before restarting after dependency changes.

## Stripe test-mode verification

The verifier is server-side and read-only. Keep it disabled until Stripe test
fixtures and the n8n workflow have been accepted.

STRIPE_ENABLED=false
STRIPE_SECRET_KEY=
STRIPE_SERVICE_TOKEN=
STRIPE_MODE=test
STRIPE_API_BASE_URL=https://api.stripe.com
STRIPE_API_VERSION=
STRIPE_TIMEOUT_SECONDS=15
STRIPE_TIMEZONE=UTC
STRIPE_MAX_PAGES=10
STRIPE_ALLOWED_PAYMENT_METHOD_TYPE=cashapp

Only `sk_test_` keys are accepted while `STRIPE_MODE=test`. The internal
service token is required on verification requests and must be configured in
the n8n credential/request header. Never place either secret in Baileys, n8n
workflow exports, logs, or WhatsApp messages.

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

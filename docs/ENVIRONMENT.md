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

## Future Stripe test mode

STRIPE_SECRET_KEY=

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

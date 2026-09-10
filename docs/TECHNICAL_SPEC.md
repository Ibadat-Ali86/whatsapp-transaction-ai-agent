# TECHNICAL SPECIFICATION

## Runtime

### Node.js
Used for Baileys WhatsApp integration.

### Python
Used for OCR, extraction, image processing, and verification services where appropriate.

### Tesseract
Primary OCR engine.

### n8n
Workflow orchestration.

### Groq
Temporary development AI vision provider.

### Gemini
Future provider. Must implement the same provider contract as Groq.

## Suggested repository structure

src/
  whatsapp/
  ocr/
  ai/
  extraction/
  duplicate/
  verification/
  verdict/
  logging/
  config/
  utils/

tests/
  unit/
  integration/
  fixtures/
  accuracy/

n8n/
  workflows/
  README.md

docs/
.agent/
scripts/

## Provider interface

Conceptual interface:

class VisionProvider:
    name: str
    def extract_payment_fields(image_bytes) -> dict

Implementations:
- GroqVisionProvider
- GeminiVisionProvider

The caller should not know which provider is active.

## Configuration

Use environment variables:

AI_PROVIDER=groq
GROQ_API_KEY=
GROQ_VISION_MODEL=
GEMINI_API_KEY=
GEMINI_VISION_MODEL=

OCR_CONFIDENCE_THRESHOLD=0.85

Never require both provider keys at runtime.

## Data contract

Incoming image event:

{
  "processing_id": "...",
  "message_id": "...",
  "group_id": "...",
  "group_name": "...",
  "sender_jid": "...",
  "received_at": "...",
  "is_forwarded": false,
  "caption_email": "customer@example.com",
  "stripe_verification_enabled": false,
  "image": {
    "mime_type": "image/jpeg",
    "base64": "..."
  }
}

The WhatsApp intake layer requires every payment screenshot to carry a
single syntactically valid customer email as its image caption. The caption
is normalized to lowercase and is the trusted lookup hint for later
verification; OCR email text remains evidence that must be compared, not
blindly trusted.

OCR result:

{
  "provider": "tesseract|groq|gemini",
  "raw_text": "...",
  "fields": {
    "email": null,
    "amount": null,
    "minutes": null,
    "payment_date": null,
    "customer_name": null,
    "status": null
  },
  "confidence": 0.0,
  "fallback_reason": null
}

If the optional AI provider is rate-limited or unavailable, the service
returns the Tesseract result with `fallback_reason=AI_PROVIDER_UNAVAILABLE`
instead of converting the whole OCR request into a server error. The
confidence value remains authoritative for later manual-review and payment
verification gates.

Stripe verification request:

{
  "processing_id": "...",
  "email": "customer@example.com",
  "amount_cents": 2500,
  "payment_date": "2026-09-09",
  "minutes": 31,
  "payment_hour": 14,
  "currency": "usd",
  "payment_method_type": "cashapp"
}

The server-side verifier reads Stripe charges in test mode, paginates within
the configured local-date window, and approves only one exact match. Multiple
matches, missing time evidence, mismatched amounts, and API failures remain
non-approving outcomes. The endpoint requires an internal service token and
Stripe keys are never accepted from request payloads.

## Financial data rules

Prefer integer cents or Decimal for money.

Example:
$10.50 -> 1050 cents.

Do not compare money using approximate floating-point equality.

## Error model

ERROR categories:
- WHATSAPP_CONNECTION_ERROR
- MEDIA_DOWNLOAD_ERROR
- OCR_ERROR
- AI_PROVIDER_ERROR
- EXTRACTION_ERROR
- DUPLICATE_CHECK_ERROR
- STRIPE_ERROR
- SHEETS_ERROR
- TELEGRAM_ERROR
- CONFIGURATION_ERROR

Each error must carry:
- processing_id;
- component;
- timestamp;
- safe error message;
- retryability.

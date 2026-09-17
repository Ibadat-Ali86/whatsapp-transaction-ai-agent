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

The WhatsApp intake layer accepts a missing or malformed caption as a
recoverable condition. One email token is extracted from a caption and
normalized to lowercase even when the caption also contains payment context;
multiple different addresses remain ambiguous. A caption email is only a
lookup hint; OCR email text remains evidence that must be compared, not blindly
trusted. If the image has no caption, a nearby email-only message from the same
sender and group may be correlated before or after the image. Without a usable
email, Stripe recovery is approved only when deterministic evidence identifies
exactly one eligible charge.

OCR result:

{
  "provider": "tesseract|groq|gemini",
  "raw_text": "...",
  "fields": {
    "email": null,
    "transaction_id": null,
    "description": null,
    "amount": null,
    "minutes": null,
    "payment_date": null,
    "payment_month": null,
    "payment_day": null,
    "customer_name": null,
    "status": null
  },
  "confidence": 0.0,
  "fallback_reason": null
}

If the optional AI provider is rate-limited or unavailable, the service
returns the Tesseract result with `fallback_reason=AI_PROVIDER_UNAVAILABLE`
instead of converting the whole OCR request into a server error. The
confidence value controls whether OCR fields are sent as Stripe constraints;
low-confidence OCR is omitted while the normalized caption email may still be
used for a separate, fail-closed Stripe lookup.

Stripe verification request:

{
  "processing_id": "...",
  "email": "customer@example.com",
  "email_candidates": ["customer@example.com", "ocr@example.com"],
  "description": "Order 002",
  "amount_cents": 2500,
  "payment_date": "2026-09-09",
  "minutes": 31,
  "payment_hour": 14,
  "payment_month": null,
  "payment_day": null,
  "currency": "usd",
  "payment_method_type": "cashapp"
}

`amount_cents`, `payment_date`, `payment_month`, `payment_day`, `minutes`, and
`payment_hour` are optional. `payment_month` and `payment_day` together
represent a receipt date such as `Aug 14`. The normalized caption email is a
lookup hint, not proof. A distinct OCR-visible email is sent as an additional
candidate, so a mistyped caption cannot hide the canonical Stripe customer.
When the caption is missing or does not match, the verifier
requires at least two independently enforceable deterministic constraints and
exactly one eligible charge. If no receipt timezone is configured,
`payment_hour` is not a hard filter because sender and Stripe clocks may differ;
minute/date/amount constraints remain enforced. Multiple matches, conflicts,
and API failures remain non-approving outcomes. When a receipt timezone is
configured, an exact amount/time Search miss gets one bounded same-day recovery
pass that relaxes only the hour; amount/date/minute/status/currency/payment
method must still identify exactly one eligible charge. The endpoint requires an
internal service token and Stripe keys are never accepted from request
payloads.

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

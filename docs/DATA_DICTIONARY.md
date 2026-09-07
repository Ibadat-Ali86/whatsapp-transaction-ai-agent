# DATA DICTIONARY

## Processing fields

processing_id
Unique processing attempt identifier.

timestamp
UTC event timestamp.

group_id
WhatsApp group identifier.

group_name
WhatsApp group display name.

sender_jid
WhatsApp sender identifier.

message_id
WhatsApp message identifier.

is_forwarded
Boolean forwarded-message flag.

## OCR fields

email
Normalized email extracted from screenshot.

amount_cents
Integer monetary amount in cents.

minutes
Two-digit minute component where available.

payment_date
Normalized date when available.

customer_name
Customer name when available.

status
Payment status text.

ocr_source
tesseract/groq/gemini.

ocr_confidence
Numeric diagnostic score.

## Verification fields

duplicate_image
Boolean/image duplicate result.

duplicate_transaction
Boolean transaction duplicate result.

stripe_charge_id
Matching Stripe charge ID.

verdict
VALID/FAKE/DUPLICATE/SUSPICIOUS/UNCLEAR/ERROR.

verdict_reason
Human-readable safe reason.

## Logging fields

duration_ms
Processing duration.

error_code
Controlled error category.

retryable
Whether retry is appropriate.

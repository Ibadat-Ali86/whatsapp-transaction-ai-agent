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

caption_email
Normalized email supplied as the WhatsApp image caption. This is the primary
Stripe lookup identity; it is still user-supplied input and not payment proof.

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

fallback_reason
Safe reason when OCR returned a local Tesseract result because the optional
cloud AI provider was unavailable. Low-confidence OCR fields are not sent as
Stripe constraints; Stripe may still perform the separate caption-email lookup.

## Verification fields

duplicate_image
Boolean/image duplicate result.

duplicate_transaction
Boolean transaction duplicate result.

stripe_charge_id
Matching Stripe charge ID.

stripe_match_status
MATCHED/NO_MATCH/AMBIGUOUS/ERROR.

stripe_reason_code
Stable safe reason for the Stripe result.

matched_transaction
Canonical amount, local date/time, customer name, status, and payment method
returned only for one eligible Stripe match.

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

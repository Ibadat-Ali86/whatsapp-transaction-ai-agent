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

transaction_id
Payment/provider identifier extracted next to an explicit transaction or
payment identifier label. It is an exact lookup hint and is compared against
the Stripe charge ID, payment intent, balance transaction, source, supported
Cash App fields, and approved transaction metadata keys.

description
Stripe charge description returned after a candidate is found. The current
receipt format does not expose this field, so it is not required input for
OCR. If a future screenshot or caption explicitly supplies it, it is
normalized and compared exactly as an additional discriminator. It is never
inferred from a dashboard screenshot, merchant name, or AI guess.

amount_cents
Integer monetary amount in cents.

minutes
Two-digit minute component from a context-associated payment time. Unlabelled
chat/message timestamps are ignored rather than treated as payment evidence.

payment_hour
24-hour receipt-clock payment hour where available. Used as a hard recovery
constraint only when `STRIPE_SCREENSHOT_TIMEZONE` is configured; otherwise it
is diagnostic because group members may use different local time zones.

payment_month
Numeric receipt month when the screenshot shows a textual month/day date such
as `Aug 14`. Used with `payment_day` as one partial-date recovery constraint.

payment_day
Numeric receipt day when the screenshot shows a textual month/day date. It is
never treated as a standalone date; month and day must be present together.

payment_date
Normalized ISO date when available. A partial textual date is represented by
`payment_month` and `payment_day` instead.

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
cloud AI provider was unavailable. Low-confidence OCR fields are not payment
proof. Stripe may still use deterministic amount/date/time evidence for a
bounded, uniquely matched recovery lookup.

## Verification fields

duplicate_image
Boolean/image duplicate result.

duplicate_transaction
Boolean transaction duplicate result.

duplicate_match_type
SHA256, PHASH, or STRIPE_TRANSACTION duplicate detection source.

duplicate_of_processing_id
Processing ID of the first accepted occurrence when a duplicate is detected.

stripe_charge_id
Matching Stripe charge ID.

claimed_stripe_charge_ids
Bounded internal list of Stripe charge IDs already claimed by the single
WhatsApp worker. It is used only to resolve a multi-match when exactly one
fresh candidate remains; it never suppresses a sole claimed match, which must
remain available for duplicate-transaction classification.

stripe_match_status
MATCHED/NO_MATCH/AMBIGUOUS/ERROR.

stripe_reason_code
Stable safe reason for the Stripe result.

matched_transaction
Canonical amount, local date/time, customer name, description, status, and
payment method returned only for one eligible Stripe match.

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

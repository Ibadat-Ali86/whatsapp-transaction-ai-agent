# LOGGING AND AUDIT SPECIFICATION

## Goal
Provide enough evidence to understand every processing decision without leaking secrets or unnecessarily retaining images.

## Processing ID

Every incoming message gets a unique processing_id.

Recommended format:
wa-YYYYMMDD-HHMMSS-<random>

## Event log schema

timestamp
processing_id
component
event
status
duration_ms
provider
message_id
group_id_hash
verdict
error_code
safe_details

## Example

2026-09-06T19:30:00Z
wa-20260906-193000-a91f
ocr
tesseract_completed
success
842
tesseract
msg123
group_hash
N/A
N/A
fields_extracted=5

## Do not log

- API keys;
- tokens;
- cookies;
- raw base64;
- full WhatsApp auth state;
- unnecessary personal information.

## Log levels

DEBUG:
development diagnostics.

INFO:
normal lifecycle events.

WARNING:
recoverable anomalies.

ERROR:
failed processing.

SECURITY:
authentication/authorization/security events.

## Retention

Development:
local logs may be retained as needed.

Production:
define retention with client before deployment.

## Audit record

For each verdict, store:
- processing ID;
- timestamp;
- input metadata;
- OCR provider;
- extracted fields;
- verification evidence;
- verdict;
- reason;
- duplicate result;
- external API outcome.

Stripe verification audit events may include the processing ID, Stripe charge
ID when uniquely matched, candidate count, safe reason code, verdict, retryable
flag, and a one-way email hash. They must not include the Stripe secret,
authorization headers, raw image data, or the full customer email.

Do not store raw image unless explicitly authorized.

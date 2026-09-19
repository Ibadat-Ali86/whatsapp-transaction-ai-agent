# Phase 3 — Duplicate Detection

## Decision policy

```text
WhatsApp message ID duplicate
  -> suppress repeated delivery

new message
  -> exact image SHA-256 duplicate?
       -> DUPLICATE, do not run OCR or Stripe again
  -> OCR + Stripe verification
  -> same uniquely matched Stripe charge ID?
       -> DUPLICATE transaction
  -> same pHash + same canonical Stripe charge ID?
       -> DUPLICATE recompressed/resized image
  -> otherwise
       -> ORIGINAL / VALID when Stripe is VALID
```

`VALID` is never inferred from an image hash. Stripe must return one eligible
succeeded charge. A pHash near-match is not sufficient by itself: email,
amount, and receipt time are not unique when a customer makes multiple
payments. The near-match path requires the same canonical Stripe charge ID on
both records; otherwise the new screenshot continues through independent
verification. `DUPLICATE` is a non-approving verdict and includes the first
processing ID for audit correlation.

The WhatsApp adapter reacts with `✅` only for a clear valid Stripe match and
uses `❌` for invalid, errored, or unresolved results. Non-valid results also
include a concise justification when bot replies are enabled; unresolved
evidence is described as not confirmed rather than automatically called fake.
It sends text only for duplicates and corrected-identity valid results,
including whether
the original was found in the same group or a named other allowlisted group
when WhatsApp metadata is available, plus the original processing ID and
detection proof. When the original message key is available, a duplicate also
gets a quoted reference on the original message; the original verdict is
preserved in that annotation.

Deleting the original WhatsApp message does not release its claim. This is
intentional: deletion is not evidence that a payment should be reprocessed.
An authorized operational reset or correction workflow is required for an
intentional re-review.

## Stored metadata

The local store contains SHA-256, pHash, one-way caption-email hash, amount,
processing ID, group hash, a sanitized group-name snapshot, and timestamps.
It does not contain raw images, Stripe secrets, or complete email addresses.
Records expire according to `DUPLICATE_RETENTION_DAYS`.

## Production boundary

The current JSON store is safe for a single Baileys process handling many
allowlisted groups. It is not a distributed lock. A multi-process or
multi-host deployment must move image and Stripe-charge claims to a shared
transactional store with a unique constraint on SHA-256 and Stripe charge ID.

## Validation

- exact SHA-256 resend across two groups;
- persisted exact hash after recreating the store;
- pHash near-match with the same canonical Stripe charge ID;
- same-looking receipts with different Stripe charge IDs remain independent;
- repeated Stripe charge with different image bytes;
- unrelated images do not become duplicates;
- duplicate and unclear replies use non-approving verdicts.

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
  -> same pHash + caption email + OCR amount?
       -> DUPLICATE recompressed/resized image
  -> otherwise
       -> ORIGINAL / VALID when Stripe is VALID
```

`VALID` is never inferred from an image hash. Stripe must return one eligible
succeeded charge. `DUPLICATE` is a non-approving verdict and includes the first
processing ID for audit correlation.

The WhatsApp adapter reacts with `✅` for a clear valid result and `❌` for a
failed or unclear result. It sends text only for duplicates, including whether
the original was found in the same group or another allowlisted group and the
original processing ID.

## Stored metadata

The local store contains SHA-256, pHash, one-way caption-email hash, amount,
processing ID, group hash, and timestamps. It does not contain raw images,
Stripe secrets, or complete email addresses. Records expire according to
`DUPLICATE_RETENTION_DAYS`.

## Production boundary

The current JSON store is safe for a single Baileys process handling many
allowlisted groups. It is not a distributed lock. A multi-process or
multi-host deployment must move image and Stripe-charge claims to a shared
transactional store with a unique constraint on SHA-256 and Stripe charge ID.

## Validation

- exact SHA-256 resend across two groups;
- persisted exact hash after recreating the store;
- pHash near-match with matching caption email and amount;
- repeated Stripe charge with different image bytes;
- unrelated images do not become duplicates;
- duplicate and unclear replies use non-approving verdicts.

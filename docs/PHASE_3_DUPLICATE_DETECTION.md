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
  -> same payment evidence fingerprint?
       -> DUPLICATE recompressed/resized image
  -> same customer + amount + complete receipt time + pHash?
       -> DUPLICATE when the payment identifier is not OCR-readable
  -> strict visual receipt fingerprint + exact pHash + same amount/time?
       -> DUPLICATE when OCR misread the identifier
  -> otherwise
       -> ORIGINAL / VALID when Stripe is VALID
```

`VALID` is never inferred from an image hash. Stripe must return one eligible
succeeded charge. A pHash near-match is not sufficient by itself: email,
amount, and receipt time are not unique when a customer makes multiple
payments. The unresolved evidence path requires the same explicit
payment-specific identifier on both records, or the same customer, amount,
complete receipt date/time, and pHash when the identifier is not OCR-readable,
or a strict visual receipt fingerprint with exact pHash equality and the same
amount/time when OCR misread the identifier;
the Stripe-resolved path still requires the same canonical Stripe charge ID.
If the current attempt is the
first one that resolves a fresh charge while the earlier matching attempt was
unresolved, the current attempt may become the one valid claim. `DUPLICATE` is
a non-approving verdict and includes the first processing ID for audit
correlation.

For receipt clocks that differ from the Stripe account timezone, the verifier
uses a bounded timezone-boundary recovery path. It may cross the displayed
receipt date by at most the real-world timezone range plus a small timestamp
margin, but it retains the exact amount, receipt minute, succeeded Cash App
status, and a strong identity constraint. A captionless receipt must provide an
exact customer name, description, or provider identifier for this path; two or
more eligible candidates remain `UNCLEAR`.

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

The local store contains SHA-256, pHash, payment-specific identifier when
available, one-way caption-email hash, amount, processing ID, group hash, a
sanitized group-name snapshot, and timestamps.
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
- pHash near-match with the same payment identifier when both Stripe lookups
  are unresolved;
- exact image resend after an unresolved first attempt remains non-approving;
- same-looking receipts with different Stripe charge IDs remain independent;
- repeated Stripe charge with different image bytes;
- unrelated images do not become duplicates;
- duplicate and unclear replies use non-approving verdicts.

# TESTING STRATEGY

## Test layers

### Unit
Test:
- email extraction;
- amount extraction;
- minute extraction;
- date parsing;
- status parsing;
- money normalization;
- confidence;
- hashing;
- verdict logic.

### Integration
Test:
- Baileys -> OCR;
- OCR -> Groq;
- n8n -> OCR;
- n8n -> Stripe test mode;
- n8n -> Sheets test sheet.

### End-to-end
Simulate:
WhatsApp image
-> processing
-> OCR
-> verification
-> verdict
-> reply.

## Accuracy test matrix

Minimum categories:
1. clear screenshot;
2. blurry screenshot;
3. dark screenshot;
4. bright screenshot;
5. rotated screenshot;
6. compressed screenshot;
7. handwritten email;
8. small email;
9. decimal amount;
10. missing field;
11. conflicting fields;
12. forwarded message;
13. duplicate image;
14. recompressed duplicate;
15. same transaction/different image.

## Failure tests

- Groq unavailable;
- Tesseract unavailable;
- n8n unavailable;
- Stripe unavailable;
- Sheets unavailable;
- WhatsApp reconnect;
- malformed base64;
- oversized image;
- invalid MIME type;
- duplicate message.

## Financial verification tests

Before production:
- exact cents;
- multiple transactions same email;
- multiple transactions same amount;
- same minute collision;
- same amount and minute with distinct transaction identifiers;
- wrong caption email with a matching transaction identifier;
- missing caption email with a matching screenshot payment identifier;
- identifier collision or identifier/payment-data conflict;
- timezone scenarios;
- refunded/failed/pending transactions;
- pagination beyond first 100 records.

## Regression rule

A new feature must not reduce previously measured accuracy.

## Acceptance

Record:
- test ID;
- input;
- expected;
- actual;
- pass/fail;
- evidence;
- timestamp;
- code version.

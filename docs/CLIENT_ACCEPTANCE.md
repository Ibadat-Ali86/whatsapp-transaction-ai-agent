# CLIENT ACCEPTANCE CRITERIA

## Functional
- WhatsApp screenshots are received.
- OCR extracts required fields reliably.
- Duplicate images are detected.
- Duplicate transactions are detected.
- Stripe verification is correct.
- Verdicts are understandable.
- Google Sheets records are complete.
- Alerts work.

## Accuracy
Client and engineering team must agree on target thresholds using a labeled dataset.

Do not use arbitrary claims such as "99% accurate" without measured evidence.

## Security
- no exposed secrets;
- restricted n8n;
- protected WhatsApp session;
- controlled Google access;
- controlled Telegram access;
- documented cloud AI data flow.

## Reliability
- reconnect behavior tested;
- API failure behavior tested;
- duplicate processing tested;
- recovery tested.

## Rollout
Start with a small pilot and expand gradually.

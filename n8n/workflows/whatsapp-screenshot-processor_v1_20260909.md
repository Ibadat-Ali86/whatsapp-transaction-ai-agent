# WhatsApp Screenshot Processor v1

- Version: 1
- Date: 2026-09-09
- Change: Phase 2 Step 1 authenticated webhook contract and local OCR routing

## Import and configure

1. Import the adjacent JSON into a local n8n instance.
2. Create a header-auth credential named `WhatsApp agent webhook auth` and set
   the same secret as the bot's `N8N_WEBHOOK_TOKEN`. Do not put the value in
   this export.
3. Confirm the OCR service is reachable at
   `http://localhost:8000/api/v1/ocr/process`. If n8n runs in a container,
   replace `localhost` with the host address reachable from that container.
4. Keep the workflow inactive until the authenticated test succeeds.
5. Set `N8N_ENABLED=true` only after the webhook test passes.

## Security notes

- The workflow rejects non-WhatsApp events, missing IDs, invalid image MIME
  types, empty payloads, and captions that are not a single email.
- Success execution data is disabled so raw image payloads are not retained by
  successful n8n executions. Configure error-data retention deliberately for
  the local environment.
- This workflow performs OCR routing only. Stripe lookup, duplicate
  detection, verdict generation, Sheets logging, and Telegram alerts remain
  later phases.

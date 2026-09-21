# SECURITY AND PRIVACY SPECIFICATION

## Security principles

1. Least privilege.
2. Secrets outside source code.
3. No production credentials in development by default. If live-mode acceptance
   is explicitly approved, use only a restricted read-only key, a dedicated
   allowlisted group, and an isolated environment.
4. No client screenshots in public repositories.
5. Minimize data retention.
6. Explicit external data transfer.
7. Audit every meaningful decision.

## Secrets

Never commit:
.env
WhatsApp auth/session
service-account JSON
Stripe keys
Groq keys
Gemini keys
Telegram bot tokens

## AI provider privacy

Tesseract:
- local processing.

Groq:
- cloud processing.
- image data leaves the local environment when fallback is invoked.

Gemini:
- cloud processing.
- same architectural privacy consideration.

Therefore the final client privacy statement must not claim that all images remain on the server.

## Image retention

Default:
- temporary only;
- delete after processing.

For accuracy testing:
- retain only approved synthetic/test screenshots;
- never commit them publicly;
- never retain client production screenshots without explicit authorization.

## Logging

Logs must never include:
- API keys;
- full access tokens;
- raw image base64;
- unnecessary payment data.

Logs may include:
- processing ID;
- component;
- status;
- timing;
- provider;
- error category;
- safe metadata.

## WhatsApp session

Keep auth/session directory outside version control.

Back it up only through an approved secure mechanism.

## WhatsApp group authorization

Baileys links the WhatsApp account as a device; WhatsApp does not provide a QR-time prompt for selecting groups. The application therefore enforces least privilege with the exact `WHATSAPP_ALLOWED_GROUP_JIDS` allowlist.

This is application-level processing isolation, not account-level WhatsApp visibility. For true account-level isolation, use a dedicated WhatsApp number that is added only to the approved groups.

The allowlist is enforced in two places:

- Baileys filters non-allowlisted group JIDs before emitting group messages to the application. Direct protocol messages remain available because WhatsApp uses them for group sender-key and Signal-session establishment.
- The application handler checks that the message is from an allowlisted group before downloading media, calling OCR, or sending a reply.

An empty allowlist is fail-closed. The bot may connect for setup, but it must not process messages until at least one approved group JID is configured.

## Private payment review proof

Full Stripe candidate identity data is never sent to a group by the review
workflow. Configure only direct WhatsApp recipients in
`PAYMENT_REVIEW_ADMIN_JIDS`; group JIDs are rejected. The private message
contains sanitized candidate fields rather than raw Stripe API objects, and it
is explicitly marked as sensitive. The Stripe secret key and service tokens
are never included in any reply.

## n8n

Restrict admin access.

Use strong credentials.

Use HTTPS/reverse proxy for production.

Firewall internal ports.

## Server

Production later:
- SSH keys;
- disable password SSH;
- firewall;
- unattended security updates where appropriate;
- least-privilege service users;
- backups;
- monitoring.

## Credential handover

Never request or transmit production secrets through normal chat logs.

Use a secure credential exchange process.

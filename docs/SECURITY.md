# SECURITY AND PRIVACY SPECIFICATION

## Security principles

1. Least privilege.
2. Secrets outside source code.
3. No production credentials in development.
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

# PROJECT CONTEXT

## Project
WhatsApp Transaction Verification AI Agent

## Client
AQ Digital LLC

## Original functional scope
Stripe / Cash App Pay payment screenshot verification across WhatsApp groups.

## Original target
50+ WhatsApp groups.

## Current owner-approved development changes

### Development environment
Ubuntu local machine first.

### Database/logging
Google Sheets is the planned production data/logging layer. PostgreSQL is not required for the current architecture.

### AI provider
Groq Vision is used during development/testing.

Gemini is reserved for later production integration.

### Hosting
No DigitalOcean initially.

Deployment occurs only after local functional, accuracy, security, and failure testing pass.

## Functional baseline

The agent receives payment screenshots from WhatsApp groups.

Important fields:
- email;
- amount;
- payment time/minutes;
- payment date;
- customer name where available;
- status where available.

Original verification concepts:
- email is the primary lookup key;
- amount must match exactly;
- minute matching was specified in the original document;
- image duplicates can be detected with SHA256 and pHash;
- transaction duplicates use email + amount + minutes.

## Important engineering warning

The original minute-only verification rule can create collisions because multiple transactions can share the same minute. It MUST be tested against collision scenarios before production acceptance.

The original confidence score is also only a field-presence heuristic. It must not be treated as proof that OCR characters are correct.

## Current phase

Phase 1:
WhatsApp test group -> Baileys -> image -> Tesseract -> extraction -> Groq fallback -> local result.

## Not currently enabled

- client production WhatsApp;
- production Stripe key;
- production Google Sheet;
- production Telegram;
- DigitalOcean;
- 50+ group rollout;
- production Gemini key.

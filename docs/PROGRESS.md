# PROJECT PROGRESS

## Current phase
Phase 2 — n8n Integration

## Status
Phase 1 code path is complete and regression-tested. The live WhatsApp test
group acceptance still requires a user-controlled test message with an email
caption. Phase 2's exported v2 workflow has passed local authenticated n8n
runtime acceptance with a synthetic OCR fixture; live Baileys acceptance and
Stripe test fixtures remain controlled follow-ups.

## Checklist

### Foundation
- [x] repository initialized
- [x] .agent instructions installed
- [x] .env.example created
- [x] .gitignore created
- [x] logging initialized
- [x] test framework initialized

### Ubuntu
- [x] Node.js verified
- [x] Python verified
- [x] Tesseract installed
- [x] npm dependencies installed

### WhatsApp
- [x] Baileys installed
- [ ] test WhatsApp account linked (live acceptance pending)
- [ ] test group detected (live acceptance pending)
- [ ] text message received (live acceptance pending)
- [ ] image message received (live acceptance pending)
- [x] image downloaded (logic implemented & verified)
- [x] temporary image deleted (lifecycle verified)

### OCR
- [x] Tesseract works
- [x] field extraction works
- [x] labeled fixtures created
- [x] accuracy benchmark created
- [x] Groq provider implemented
- [x] Groq fallback tested (interface implemented & tested)

### n8n
- [x] isolated n8n 1.100.1 runtime installed for acceptance
- [x] versioned webhook workflow exported
- [x] authenticated webhook client implemented
- [x] email-caption validation implemented
- [x] message ID idempotency implemented
- [x] optional OCR-to-Stripe v2 workflow exported
- [x] workflow payload bounds, duplicate guard, and execution-retention hardening added
- [x] webhook tested with synthetic OCR fixture
- [x] authenticated webhook tested, including invalid-token rejection
- [x] synthetic message-handler -> n8n -> OCR -> reply smoke test
- [ ] Baileys -> n8n -> Baileys tested

### Verification
- [x] n8n duplicate detection tested with repeated message ID
- [x] server-side Stripe test-mode verifier implemented and unit-tested
- [ ] Stripe test-mode live fixtures
- [ ] verdict engine
- [ ] Google Sheets test sheet
- [ ] Telegram test bot

### Production readiness
- [ ] security review
- [ ] privacy review
- [ ] failure testing
- [ ] local acceptance
- [ ] deployment plan
- [ ] DigitalOcean approved

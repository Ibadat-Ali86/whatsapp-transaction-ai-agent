# PHASED BUILD PLAN

## Phase 0 — Repository and agent controls
Deliver:
- project repository;
- .agent instructions;
- environment templates;
- logging;
- tests;
- documentation.

Exit:
- agent can build/test safely.

## Phase 1 — WhatsApp + OCR
Deliver:
- Baileys connection;
- test group detection;
- image download;
- Tesseract OCR;
- field extraction;
- OCR test fixtures;
- Groq fallback interface.

Exit:
- labeled screenshot test set reaches agreed accuracy target.

## Phase 2 — n8n integration
Deliver:
- local n8n;
- webhook;
- authenticated request;
- workflow routing;
- response back to Baileys.

Exit:
- end-to-end local event succeeds.

## Phase 3 — Duplicate detection (implemented for the local multi-group bot)
Deliver:
- SHA256;
- pHash;
- transaction composite key;
- tests for resized/recompressed images.

Exit:
- duplicate test matrix passes;
- exact image resends are detected across allowlisted groups and restarts;
- uniquely matched Stripe charge IDs are claimed once.

Production note: the current persisted JSON store supports one bot process.
Use a shared transactional store before running multiple bot processes or
hosts.

## Phase 4 — Stripe verification
Deliver:
- Stripe test-mode integration first;
- customer lookup;
- transaction matching;
- collision testing;
- safe verdicts.

Exit:
- Stripe test cases pass.

## Phase 5 — Google Sheets
Deliver:
- schema;
- append;
- lookup;
- least-privilege credentials;
- audit logging.

Exit:
- records are correct and recoverable.

## Phase 6 — Verdict/replies
Deliver:
- VALID;
- FAKE;
- DUPLICATE;
- SUSPICIOUS;
- UNCLEAR;
- ERROR;
- reply templates.

Exit:
- all decision paths tested.

## Phase 7 — Telegram
Deliver:
- exception alerts;
- daily report.

## Phase 8 — Local full-system testing
Test:
- happy path;
- malformed images;
- duplicates;
- timeouts;
- API failures;
- WhatsApp reconnect;
- n8n failure;
- provider failure.

## Phase 9 — Security/privacy acceptance
Review:
- secrets;
- logs;
- temp files;
- cloud AI transmission;
- access controls.

## Phase 10 — Deployment preparation
Only after local acceptance:
- DigitalOcean;
- Ubuntu server hardening;
- n8n deployment;
- process manager;
- reverse proxy;
- backups;
- monitoring.

## Phase 11 — Production pilot
Rollout:
1-3 groups -> 5 -> 10 -> 25 -> 50+.

Never jump directly to all groups.

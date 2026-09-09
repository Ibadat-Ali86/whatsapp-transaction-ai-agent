# CHANGELOG

## 0.3.1 — Workflow safety hardening
- Added bounded base64 input validation to both versioned n8n workflows.
- Added v2 workflow-level duplicate protection and safe duplicate responses.
- Disabled n8n success/error execution-data retention for image payloads.

## 0.3.0 — Gated Stripe verification workflow
- Added the optional n8n v2 OCR-to-Stripe test-mode route.
- Added server-side verification result formatting in WhatsApp replies.
- Added workflow structure and secret-boundary regression tests.

## 0.2.0 — Phase 1 completion and Phase 2 Step 1
- Improved OCR candidate selection for compact phone screenshots.
- Added email-caption validation and safe WhatsApp rejection messaging.
- Added bounded message-id idempotency protection.
- Added authenticated n8n webhook client with timeout and retry handling.
- Added versioned n8n workflow export for local OCR routing.
- Added Phase 2 analysis and local acceptance runbook.

## 0.1.0 — Documentation baseline
- Added controlled AI-agent documentation package.
- Added PRD.
- Added system architecture.
- Added technical specification.
- Added phased build plan.
- Added OCR specification.
- Added n8n specification.
- Added security and privacy controls.
- Added testing strategy.
- Added logging/audit specification.
- Added change-control rules.
- Added persistent project memory.
- Added progress tracker.
- Added release and incident runbooks.
- Added Groq development provider decision.
- Added Gemini future-provider decision.
- Added local-first/no-DigitalOcean-at-start decision.

# CHANGELOG

## 0.3.4 — OCR provider resilience
- Preserve Tesseract results when the optional Groq/Gemini fallback is
  unavailable or rate-limited.
- Added safe OCR reason codes for genuine Tesseract failures.
- Prevented low-confidence OCR fallback results from entering the n8n Stripe
  verification branch.

## 0.3.3 — Stripe verifier runtime acceptance
- Exercised the real FastAPI Stripe verification endpoint against a disposable
  read-only Stripe-compatible fixture.
- Confirmed unauthorized requests return `401` and one exact Cash App match
  returns `VALID` without exposing credentials.

## 0.3.2 — n8n runtime acceptance hardening
- Added structured HTTP 400 responses for invalid v2 webhook events.
- Verified the v2 export imports with distinct webhook and Stripe credentials.
- Verified authenticated OCR, duplicate suppression, and caption/OCR conflict
  behavior in an isolated n8n 1.100.1 runtime.

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

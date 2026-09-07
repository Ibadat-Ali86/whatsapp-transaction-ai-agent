# ARCHITECTURE DECISION LOG

## ADR-001 — Local-first development
Decision:
Build and test locally before DigitalOcean.

Reason:
Lower cost, safer experimentation, easier debugging.

Status:
Accepted.

## ADR-002 — Google Sheets as planned data layer
Decision:
Use Google Sheets instead of PostgreSQL for the operational logging/database requirement.

Reason:
Matches current project scope and simplifies early deployment.

Status:
Accepted.

## ADR-003 — Provider abstraction
Decision:
AI vision provider must be configurable.

Reason:
Groq is used for development; Gemini is planned later.

Status:
Accepted.

## ADR-004 — Groq during development
Decision:
Use Groq Vision for development/testing fallback.

Reason:
Allows vision-model testing without using the future production Gemini credential.

Status:
Accepted.

## ADR-005 — Tesseract first
Decision:
Run local Tesseract before cloud AI.

Reason:
Lower cost, local processing, fast baseline.

Status:
Accepted.

## ADR-006 — n8n remains final orchestration layer
Decision:
Use n8n in final architecture, but introduce it after Phase 1.

Reason:
Avoid debugging multiple integration layers simultaneously.

Status:
Accepted.

## ADR-007 — Minute-only verification requires validation
Decision:
Retain as documented baseline only until collision testing proves it safe.

Reason:
Minute-only matching can produce multiple candidates.

Status:
Accepted with production-review requirement.

# CHANGE CONTROL — Agent Policy & Log

## Purpose

This document serves two functions:

1. **Policy**: Establishes how AI coding agents must classify and record every significant change.
2. **Log**: Acts as the active change register for this project.

Reference: `docs/CHANGE_CONTROL.md` contains the governing policy rules. This file is the agent-facing operational log.

---

## Change Classification

| Class | Scope | Agent Authority |
|-------|-------|-----------------|
| **C0** | Documentation only | Permitted |
| **C1** | Local non-production code | Permitted; requires tests |
| **C2** | Workflow / integration | Permitted; requires integration tests |
| **C3** | Security / configuration changes | Permitted with security review |
| **C4** | Production credentials / data | **Requires explicit human approval** |
| **C5** | Production deployment | **Requires release checklist + rollback plan + human approval** |

**AI agents must not perform C4 or C5 actions without explicit written authorization from the project owner.**

---

## Required Change Record Format

Every significant change (C1 and above) must be appended to the log below using this template:

```
## CC-XXXX — [Short Title]

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-XXXX |
| **Date**           | YYYY-MM-DD |
| **Class**          | C0 / C1 / C2 / C3 / C4 / C5 |
| **Agent**          | [Agent name/session ID] |
| **Requested by**   | [Human or task reference] |
| **Phase**          | Phase N |
| **Reason**         | [Why this change was made] |
| **Requirement**    | [PRD/spec reference, e.g., FR-004] |
| **Files changed**  | [List of files] |
| **Behavior changed** | [What changed functionally] |
| **Security impact** | None / [description] |
| **Data impact**    | None / [description] |
| **Tests run**      | [Test names / commands / results] |
| **Rollback**       | [How to revert] |
| **Documentation updated** | Yes / No / [which files] |
| **Status**         | COMPLETE / IN-PROGRESS / BLOCKED |
```

---

## Forbidden Shortcuts

Per `docs/CHANGE_CONTROL.md`, agents must **never**:

- Comment out failing tests to make the build pass
- Weaken validation logic to make tests pass
- Hard-code secrets in any file
- Delete logs or test output to hide failures
- Silently change business rules (e.g., verdict thresholds, money-matching logic)
- Bypass payment verification logic
- Make destructive Git operations (`git push --force`, `git reset --hard` on shared branches) without explicit authorization

---

## Change Log

<!-- Append new change records below this line. Most recent first. -->

### CC-0008 — Multi-Group Burst Intake and Memory Bounding

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0008 |
| **Date**           | 2026-09-16 |
| **Class**          | C2 |
| **Agent**          | Codex |
| **Requested by**   | Project owner |
| **Phase**          | Phase 2 |
| **Reason**         | Keep 50+ group bursts responsive while preserving a single safe processing worker and bound temporary caption-correlation memory. |
| **Requirement**    | Multi-group fairness, backpressure, retry safety, and production observability |
| **Files changed**  | `src/whatsapp/message-handler.js`, `tests/unit/whatsapp/message-handler.test.js`, `docs/ENVIRONMENT.md`, `docs/DEPLOYMENT_DIGITALOCEAN.md` |
| **Behavior changed** | Batch intake now performs bounded caption-association waits concurrently; the queue still processes expensive OCR/Stripe work with configured single-worker concurrency. Stale nearby-email entries are expired and capped at 4,096 sender/group keys. |
| **Security impact** | Same-group/same-sender correlation rules are unchanged; no new data is persisted or logged. |
| **Data impact**    | None; only short-lived in-memory correlation entries are bounded more strictly. |
| **Tests run**      | `npm run test:whatsapp` (50 passed); `.venv/bin/python -m pytest -q` (118 passed); 50-group handler burst probe, 50-group queue fairness probe, 50-group allowlist/duplicate probe, n8n smoke test, syntax checks, and `git diff --check` (passed). |
| **Rollback**       | Revert CC-0008 changes; retain the prior single-worker queue behavior. |
| **Documentation updated** | Yes — `docs/ENVIRONMENT.md`, `docs/DEPLOYMENT_DIGITALOCEAN.md` |
| **Status**         | COMPLETE |

### CC-0007 — Mistyped Caption Recovery and Explicit Non-Approval Reactions

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0007 |
| **Date**           | 2026-09-16 |
| **Class**          | C2 |
| **Agent**          | Codex |
| **Requested by**   | Project owner |
| **Phase**          | Phase 2 |
| **Reason**         | Recover valid Stripe payments when a WhatsApp caption email is mistyped, and remove ambiguous payment reactions. |
| **Requirement**    | Stripe-authoritative verification; valid, invalid, unresolved, and duplicate outcome handling |
| **Files changed**  | `src/verification/stripe_verifier.py`, `src/ocr/service.py`, `src/whatsapp/message-handler.js`, `src/whatsapp/reply-formatter.js`, `scripts/smoke_n8n_adapter.js`, both v2 n8n workflow exports, related unit tests, and verification documentation |
| **Behavior changed** | Caption and OCR-visible emails are preserved as separate candidates; Stripe can recover the canonical customer identity for a unique eligible charge. `✅` is reserved for confirmed valid matches; non-duplicate non-valid outcomes use `❌` with a professional justification. |
| **Security impact** | Read-only Stripe access is unchanged; no secrets or payment payloads are logged or added to workflow exports. |
| **Data impact**    | None; runtime duplicate data is not modified by this change. |
| **Tests run**      | `.venv/bin/python -m pytest -q` (118 passed); `npm run test:whatsapp` (49 passed); `npm run smoke:n8n` (passed); Node syntax checks, Pydantic contract smoke test, workflow JSON validation, and `git diff --check` (passed). |
| **Rollback**       | Revert CC-0007 changes and re-import the prior v2 workflow export. |
| **Documentation updated** | Yes — `docs/ENVIRONMENT.md`, `docs/N8N_WORKFLOW_SPEC.md`, `docs/PHASE_2_ANALYSIS.md`, `docs/PHASE_3_DUPLICATE_DETECTION.md`, `docs/TECHNICAL_SPEC.md` |
| **Status**         | COMPLETE |

### CC-0006 — Baileys Session Conflict Protection

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0006 |
| **Date**           | 2026-09-16 |
| **Class**          | C2 |
| **Agent**          | Codex |
| **Requested by**   | Project owner |
| **Phase**          | Phase 2 |
| **Reason**         | Stop the reconnect loop caused by WhatsApp `connectionReplaced` conflicts and prevent multiple local bot processes from sharing one auth state. |
| **Requirement**    | Reliability: reconnect behavior, single-session operation, incident recovery |
| **Files changed**  | `src/whatsapp/connection.js`, `src/whatsapp/index.js`, `src/whatsapp/config.js`, `src/whatsapp/process-lock.js`, `.env.example`, `docs/ENVIRONMENT.md`, `docs/INCIDENT_RUNBOOK.md`, `docs/DEPLOYMENT_DIGITALOCEAN.md`, `tests/unit/whatsapp/baileys-compatibility.test.js`, `tests/unit/whatsapp/process-lock.test.js` |
| **Behavior changed** | Disconnect reason `440`/`connectionReplaced` is treated as terminal and no longer auto-reconnects; active queues stop using a closed socket; queued work starts only after `connection=open`; a PID lock prevents concurrent local bot instances and recovers stale markers. Transient network disconnects retain bounded exponential reconnect. |
| **Security impact** | Auth files are not deleted or modified beyond existing Baileys credential updates; the lock file contains only a local process ID. |
| **Data impact**    | None; queued jobs and duplicate metadata are preserved. |
| **Tests run**      | `npm run test:whatsapp` (47 passed before the startup-order adjustment); `node --check` for changed Node files (passed); second-start lock probe exited 1 with `BOT_ALREADY_RUNNING`; local Baileys reconnect behavior was observed. |
| **Rollback**       | Revert CC-0006 changes; preserve the auth directory and queue/data volumes. |
| **Documentation updated** | Yes — `.env.example`, `docs/ENVIRONMENT.md`, `docs/INCIDENT_RUNBOOK.md`, `docs/DEPLOYMENT_DIGITALOCEAN.md` |
| **Status**         | COMPLETE |

### CC-0005 — Timezone-Tolerant Stripe Evidence Recovery

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0005 |
| **Date**           | 2026-09-16 |
| **Class**          | C2 |
| **Agent**          | Codex |
| **Requested by**   | Project owner |
| **Phase**          | Phase 2 |
| **Reason**         | Prevent valid Stripe payments from being downgraded to `⚠️` when receipt clocks differ from the configured Stripe account timezone or when Search is not yet indexed. |
| **Requirement**    | PRD: FR-003, FR-004, FR-010; Stripe-authoritative verification and conservative ambiguity handling |
| **Files changed**  | `src/verification/stripe_verifier.py`, `tests/unit/test_stripe_verifier.py` |
| **Behavior changed** | Amount-bearing evidence now has a bounded same-day recovery pass that can relax only the potentially shifted receipt hour while retaining amount, date, minute, status, currency, payment method, and unique-match requirements. Email identity and provider transaction-ID fallbacks may relax OCR time constraints only when the remaining Stripe evidence is unique; Search-empty responses retain the bounded list fallback. |
| **Security impact** | Read-only Stripe access is unchanged. Relaxed matching is conservative and never approves an ambiguous candidate or an ineligible charge. |
| **Data impact**    | None; no payment records or secrets are persisted by this change. |
| **Tests run**      | `.venv/bin/python -m pytest -q tests/unit/test_stripe_verifier.py` (29 passed). |
| **Rollback**       | Revert CC-0005 changes; CC-0003 Stripe Search and bounded fallback behavior remains available. |
| **Documentation updated** | Yes — this change record. |
| **Status**         | COMPLETE |

### CC-0004 — Robust WhatsApp Email Evidence Correlation

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0004 |
| **Date**           | 2026-09-16 |
| **Class**          | C2 |
| **Agent**          | Codex |
| **Requested by**   | Project owner |
| **Phase**          | Phase 2 |
| **Reason**         | Accept real-world WhatsApp payment submissions with mixed captions, OCR-visible emails, and nearby email messages sent before or after an image. |
| **Requirement**    | PRD: FR-003, FR-004, FR-010; optional caption and Stripe-authoritative verification requirements |
| **Files changed**  | `src/whatsapp/caption-email.js`, `src/whatsapp/message-handler.js`, `docs/ENVIRONMENT.md`, `docs/TECHNICAL_SPEC.md`, `docs/N8N_WORKFLOW_SPEC.md`, `tests/unit/whatsapp/caption-email.test.js`, `tests/unit/whatsapp/message-handler.test.js` |
| **Behavior changed** | One unambiguous email token is extracted from mixed image captions; exact email-only text messages from the same sender/group may be correlated within the configured window on either side of an image; Stripe remains the final verification authority. |
| **Security impact** | Correlation remains restricted to the same group and sender, with a bounded time window; multiple addresses and arbitrary group text are rejected. |
| **Data impact**    | None; no screenshots or plaintext email history is persisted by this change. |
| **Tests run**      | `npm run test:whatsapp` (45 passed). |
| **Rollback**       | Revert CC-0004 changes; existing Stripe/OCR behavior remains available. |
| **Documentation updated** | Yes — `docs/ENVIRONMENT.md`, `docs/TECHNICAL_SPEC.md`, `docs/N8N_WORKFLOW_SPEC.md` |
| **Status**         | COMPLETE |

### CC-0003 — Narrowed Stripe Search for Captionless Receipts

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0003 |
| **Date**           | 2026-09-16 |
| **Class**          | C2 |
| **Agent**          | Codex |
| **Requested by**   | Project owner |
| **Phase**          | Phase 2 |
| **Reason**         | Prevent large live Stripe accounts from missing valid captionless receipts because a broad charge-list scan reaches the configured pagination ceiling. |
| **Requirement**    | PRD: FR-010; captionless Stripe recovery and timezone requirements |
| **Files changed**  | `src/verification/stripe_verifier.py`, `src/whatsapp/config.js`, `src/whatsapp/message-handler.js`, `n8n/workflows/whatsapp-screenshot-processor_v2_20260910.json`, `n8n/workflows/whatsapp-screenshot-processor_v2_docker_20260915.json`, `scripts/smoke_n8n_adapter.js`, `docs/ENVIRONMENT.md`, `tests/unit/test_stripe_verifier.py`, `tests/unit/whatsapp/n8n-workflow.test.js`, `tests/unit/whatsapp/message-handler.test.js` |
| **Behavior changed** | Amount-bearing evidence uses a server-side Stripe Charges Search query constrained by amount, currency, succeeded status, and a bounded time window; an empty Search result falls back to a bounded list query for eventual consistency; n8n resolves a `Today` receipt date in the configured Stripe timezone; local matching remains authoritative. |
| **Security impact** | Read-only Stripe access remains unchanged; no secrets or payment payloads were added to workflow exports or logs. |
| **Data impact** | None; only bounded in-memory response caching remains in use. |
| **Tests run**      | `.venv/bin/python -m pytest -q` (116 passed); `npm run test:whatsapp` (42 passed); `npm run smoke:n8n` (passed with expected `⚠️` for intentionally skipped Stripe); workflow JSON parse and `git diff --check` (passed). |
| **Rollback**       | Revert CC-0003 changes and re-import the prior v2 workflow export. |
| **Documentation updated** | Yes — `docs/ENVIRONMENT.md` |
| **Status**         | COMPLETE |

### CC-0002 — Phase 1 WhatsApp Ingestion & OCR Microservice Stack Implementation

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0002 |
| **Date**           | 2026-09-09 |
| **Class**          | C1 |
| **Agent**          | Antigravity AI Automation Expert |
| **Requested by**   | Project owner |
| **Phase**          | Phase 1 |
| **Reason**         | Implement Phase 1: Baileys WhatsApp bot connection, image downloading, Tesseract OCR preprocessing, provider abstraction, Groq fallback, structured field extraction, FastAPI OCR service, and accuracy benchmark. |
| **Requirement**    | PRD: FR-001..FR-007; Phase Plan: Phase 1 deliverable & exit criteria |
| **Files changed**  | `src/config/settings.py`, `src/logging/audit.py`, `src/utils/image_utils.py`, `src/ocr/preprocessing.py`, `src/ocr/tesseract_processor.py`, `src/ai/provider.py`, `src/ai/groq_provider.py`, `src/ai/gemini_provider.py`, `src/extraction/extractor.py`, `src/ocr/engine.py`, `src/ocr/service.py`, `src/whatsapp/*.js`, `tests/unit/*`, `tests/integration/*`, `tests/accuracy/*`, `scripts/*.sh`, `requirements.txt`, `package.json` |
| **Behavior changed** | End-to-end Phase 1 execution path available: WhatsApp image message -> download -> OCR service -> Tesseract / Groq fallback -> field extraction -> formatted WhatsApp reply. |
| **Security impact** | Zero secrets stored in repo; Pydantic SecretStr used; audit logs sanitize sensitive inputs and never echo image base64; temporary image lifecycle strictly enforced (immediate cleanup in finally blocks). |
| **Data impact**    | Temporary images stored in tmp/ and deleted immediately. Integer cents representation for all monetary values. |
| **Tests run**      | `pytest tests/unit tests/integration` (68 passed, 83% coverage), `python3 -m tests.accuracy.benchmark` (verified). |
| **Rollback**       | `git revert <commit-hash>` |
| **Documentation updated** | `docs/PROGRESS.md`, `.agent/CHANGE_CONTROL.md`, `.env.example`, `tests/fixtures/ocr/README.md` |
| **Status**         | COMPLETE |

### CC-0001 — Architecture Initialization

| Field              | Value |
|--------------------|-------|
| **ID**             | CC-0001 |
| **Date**           | 2026-09-07 |
| **Class**          | C0 |
| **Agent**          | Antigravity (initialization task) |
| **Requested by**   | Project owner |
| **Phase**          | Phase 0 |
| **Reason**         | Establish repository skeleton, agent governance, and directory structure per the initialization prompt. |
| **Requirement**    | Phase 0 exit criteria: repository initialized, .agent instructions installed, .env.example created, .gitignore created, test framework initialized |
| **Files changed**  | `.gitignore`, `.env.example`, `.agent/README.md`, `.agent/CHANGE_CONTROL.md`, `n8n/README.md`, `src/*/gitkeep`, `tests/*/gitkeep`, `scripts/.gitkeep` |
| **Behavior changed** | No application behavior — initialization only |
| **Security impact** | `.gitignore` now protects secrets, WhatsApp session data, and credential files from VCS |
| **Data impact**    | None |
| **Tests run**      | Pre-commit git inspection: no secrets staged |
| **Rollback**       | `git revert HEAD` or delete the repository |
| **Documentation updated** | Yes — `.agent/README.md` upgraded from stub |
| **Status**         | COMPLETE |

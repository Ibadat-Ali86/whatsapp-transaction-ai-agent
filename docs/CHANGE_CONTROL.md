# CHANGE CONTROL

## Purpose
Prevent AI agents from making uncontrolled modifications.

## Required change record

Every significant change must record:

ID:
Date:
Agent:
Requested by:
Reason:
Files changed:
Behavior changed:
Security impact:
Data impact:
Tests:
Result:
Rollback:
Documentation updated:

## Change classes

### C0 — Documentation only
Low risk.

### C1 — Local non-production code
Requires tests.

### C2 — Workflow/integration
Requires integration tests.

### C3 — Security/configuration
Requires security review.

### C4 — Production credentials/data
Requires explicit human approval.

### C5 — Production deployment
Requires release checklist and rollback plan.

AI agents must not perform C4/C5 actions without explicit authorization.

## CC-0010

Date: 2026-09-19
Agent: Codex
Requested by: User
Reason: Reduce false review and duplicate classifications in multi-group
WhatsApp payment processing.
Files changed: Stripe verifier, OCR request contract, Baileys duplicate store
and message handler, n8n workflow exports, regression tests, and operational
documentation.
Behavior changed: bounded broad Stripe recovery is attempted after a narrow
search misses; one fresh candidate can disambiguate already-claimed matches;
pHash requires the same canonical Stripe charge ID; duplicate replies can
annotate the original WhatsApp message without changing its stored verdict.
Security impact: Stripe remains read-only; claimed IDs are internal
identifiers only; no credentials or raw images are added to the store or
workflow exports.
Data impact: existing duplicate records remain readable; new records may
contain sanitized message-key metadata and verification evidence fields.
Tests: full Python suite (127 tests) and WhatsApp/n8n Node suite (53 tests)
passed, plus syntax, workflow-JSON, and diff checks.
Result: Implemented locally; production deployment and live Stripe/WhatsApp
acceptance test are not performed by this change.
Rollback: revert the working-tree changes and redeploy the prior verified
application/workflow exports; do not delete the duplicate ledger.
Documentation updated: ENVIRONMENT.md, PHASE_3_DUPLICATE_DETECTION.md,
N8N_WORKFLOW_SPEC.md, DATA_DICTIONARY.md.

## Rollback

Before risky changes:
- create git commit;
- export n8n workflow;
- back up relevant configuration;
- document rollback command.

## Forbidden shortcuts

Never:
- comment out failing tests;
- weaken validation;
- hard-code secrets;
- delete logs to hide failures;
- silently change business rules.

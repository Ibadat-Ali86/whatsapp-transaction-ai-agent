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

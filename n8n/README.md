# n8n Workflows

## Purpose

This directory stores exported n8n workflow JSON files for version control.

**n8n is the final orchestration layer of the system.** It is introduced in Phase 2, after the Phase 1 WhatsApp/OCR path is stable and proven.

## Current Status

Phase 2 Step 1 is exported at
`workflows/whatsapp-screenshot-processor_v1_20260909.json` with setup notes in
the adjacent Markdown file. The v1 workflow remains the rollback-safe
OCR-only option.

The gated Stripe test-mode route is exported at
`workflows/whatsapp-screenshot-processor_v2_20260910.json`. Keep v1 as the
rollback-safe OCR-only workflow until v2's n8n, verifier, and Stripe test
fixtures pass together. The v2 export has passed isolated n8n `1.100.1`
authenticated OCR, duplicate, invalid-token, invalid-caption, and
caption/OCR-conflict acceptance checks; live WhatsApp and Stripe fixtures are
still required before production activation.

## Workflow Naming Convention

```
<workflow-name>_v<version>_<YYYYMMDD>.json
```

Example: `whatsapp-screenshot-processor_v1_20260910.json`

## Required Fields Per Export

Every committed workflow export must document (in a companion `.md` or in the filename/header):

- `version`
- `date`
- `change description`

## Security Rules

Per `docs/N8N_WORKFLOW_SPEC.md`:

- **NEVER** store credential values inside exported workflow JSON.
- Webhook authentication must be configured; an unauthenticated production webhook carrying payment data is forbidden.
- Do not expose port 5678 to the public internet during local development.
- Disable successful and failed execution data retention when a workflow
  carries raw image base64.

## Idempotency Requirement

The workflow must avoid processing the same WhatsApp message twice.
Use `message_id` + source identifier as the idempotency key.

## Reference

See `docs/N8N_WORKFLOW_SPEC.md` for the full workflow specification.

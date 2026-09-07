# n8n Workflows

## Purpose

This directory stores exported n8n workflow JSON files for version control.

**n8n is the final orchestration layer of the system.** It is introduced in Phase 2, after the Phase 1 WhatsApp/OCR path is stable and proven.

## Current Status

**NOT YET CREATED.** Workflow files will be added in Phase 2.

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

## Idempotency Requirement

The workflow must avoid processing the same WhatsApp message twice.
Use `message_id` + source identifier as the idempotency key.

## Reference

See `docs/N8N_WORKFLOW_SPEC.md` for the full workflow specification.

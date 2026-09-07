# WhatsApp Transaction Verification AI Agent — Agent Build Documentation

## Purpose
This repository contains the controlled documentation package for building the WhatsApp Transaction Verification AI Agent for AQ Digital LLC.

The documentation is intentionally designed for AI coding agents such as Cursor, Antigravity, Claude Code, Codex, or similar agents.

## Non-negotiable development strategy

1. Build locally on Ubuntu first.
2. Start with the smallest working slice: WhatsApp test group -> Baileys -> image reception -> OCR.
3. Use Tesseract as the primary local OCR engine.
4. Use Groq Vision as the temporary cloud fallback during development/testing.
5. Gemini is a later production provider and must not be hard-coded into the architecture.
6. Do not buy/provision DigitalOcean at the beginning.
7. Do not use client production WhatsApp, Stripe credentials, Google Sheets, Telegram, or production data during early development.
8. Google Sheets is the planned production logging/database layer; PostgreSQL is not required for the current scope.
9. n8n is part of the final architecture, but it is introduced after the WhatsApp/OCR slice is proven.
10. Every meaningful change must be tested, documented, logged, and traceable.

## Source of truth

The original client project documentation is preserved as the functional baseline. It specifies Baileys, n8n, Tesseract, Gemini fallback, Stripe verification, duplicate detection, Google Sheets logging, Telegram alerts, and 50+ WhatsApp groups.

This package supersedes the original document only where the project owner has explicitly changed:
- local-first development;
- no DigitalOcean initially;
- Google Sheets rather than PostgreSQL;
- Groq rather than Gemini during development/testing;
- provider-agnostic AI interface so Gemini can replace Groq later.

## Required reading order for an AI agent

1. .agent/AGENT_INSTRUCTIONS.md
2. .agent/PROJECT_CONTEXT.md
3. .agent/CHAT_MEMORY.md
4. docs/PRD.md
5. docs/SYSTEM_ARCHITECTURE.md
6. docs/TECHNICAL_SPEC.md
7. docs/PHASE_PLAN.md
8. docs/OCR_SPEC.md
9. docs/SECURITY.md
10. docs/TESTING_STRATEGY.md
11. docs/CHANGE_CONTROL.md
12. docs/LOGGING_AND_AUDIT.md

Only then should the agent inspect or modify source code.

## Current implementation phase

PHASE 1 — WhatsApp Test Group + OCR Validation.

Expected current flow:

WhatsApp Test Group
-> Baileys
-> receive image
-> local temporary image buffer/file
-> Tesseract OCR
-> structured extraction
-> optional Groq Vision fallback
-> local test result/log

No Stripe verification, Google Sheets production logging, Telegram alerts, or DigitalOcean deployment is required in Phase 1.

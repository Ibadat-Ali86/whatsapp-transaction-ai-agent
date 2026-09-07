# AI AGENT CHAT MEMORY / PROJECT MEMORY

This file is persistent project memory for coding agents.

## Current state
- OS: Ubuntu Linux
- Development mode: local-first
- Current phase: WhatsApp test group + OCR
- Primary OCR: Tesseract
- Temporary AI fallback: Groq Vision
- Future AI fallback: Gemini
- Production logging/database target: Google Sheets
- Workflow engine: n8n
- WhatsApp transport: Baileys
- Payment provider: Stripe
- Production host: DigitalOcean later, not now

## Decisions already made
1. Do not purchase DigitalOcean at project start.
2. Test locally first.
3. Do not use client production credentials during early phases.
4. Use Groq instead of Gemini during development.
5. Keep AI provider configurable.
6. Use Google Sheets instead of PostgreSQL for the planned production logging layer.
7. n8n remains part of the final architecture.
8. Introduce n8n after the basic WhatsApp/OCR path is proven.
9. Security and privacy are first-class requirements.

## Current objective
Prove that a WhatsApp test group can deliver a payment screenshot to the local agent and produce accurate OCR/extracted fields.

## Last known blockers
None unless recorded in docs/PROGRESS.md.

## Agent memory rule
Never overwrite this file with temporary assumptions.
Only update durable project decisions, confirmed progress, constraints, and important discoveries.

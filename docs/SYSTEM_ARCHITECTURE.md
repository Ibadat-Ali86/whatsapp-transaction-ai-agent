# SYSTEM ARCHITECTURE

## Target architecture

WhatsApp Groups
    |
    v
Baileys Node.js Bot
    |
    v
Durable Screenshot Queue
    |
    v
n8n Webhook
    |
    +--> image/hash preprocessing
    |
    +--> OCR service
            |
            +--> Tesseract local
            |
            +--> Groq Vision fallback (development)
            |
            +--> Gemini Vision fallback (future production)
    |
    +--> field validation
    |
    +--> duplicate detection
    |
    +--> Stripe verification
    |
    +--> verdict engine
    |
    +--> Google Sheets logging
    |
    +--> Telegram alerts
    |
    v
Baileys
    |
    v
WhatsApp reply

## Development architecture

During Phase 1, n8n is intentionally not required in the critical path.

WhatsApp
 -> Baileys
 -> local OCR service
 -> local test report

After this works:

Baileys
 -> n8n webhook
 -> OCR service
 -> result
 -> Baileys

## Component responsibilities

### Baileys
WhatsApp transport and message/media handling. It persists incoming jobs and
uses one controlled worker so OCR, n8n, and Stripe calls are not started in
parallel during group bursts.

### Processing queue
The local queue is the source of truth for job lifecycle while the single-bot
deployment is running. It provides per-group FIFO ordering, fair scheduling,
bounded backlog, retry backoff, restart recovery, and dead-letter handling.
It stores metadata only and keeps screenshot files temporary.

### n8n
Workflow orchestration, routing, external integrations, scheduling, and operational automation.

### OCR service
Image processing, Tesseract, AI provider fallback, structured extraction.

### Verification service
Stripe lookup and matching.

### Duplicate service
SHA256, pHash, and transaction-key checks.

### Verdict service
Combines evidence and produces VALID/FAKE/DUPLICATE/SUSPICIOUS/UNCLEAR/ERROR.

### Google Sheets
Operational transaction log/dashboard in the planned production architecture.

### Telegram
Exception alerts and daily reporting.

## Trust boundaries

1. WhatsApp -> local system
2. Local system -> n8n
3. Local OCR -> local
4. Local system -> Groq/Gemini cloud API
5. Local system -> Stripe
6. Local system -> Google
7. Local system -> Telegram

Each external boundary requires explicit credentials, timeout handling, and error handling.

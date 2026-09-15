# ENVIRONMENT CONFIGURATION

Create .env locally from .env.example.

## Development

AI_PROVIDER=groq

GROQ_API_KEY=
GROQ_VISION_MODEL=

GEMINI_API_KEY=
GEMINI_VISION_MODEL=

OCR_CONFIDENCE_THRESHOLD=0.85

N8N_BASE_URL=http://localhost:5678
N8N_WEBHOOK_PATH=/webhook/whatsapp-screenshot
N8N_HEALTH_TIMEOUT_MS=5000

LOG_LEVEL=INFO

`STRIPE_VERIFICATION_ENABLED=true` is required in the Baileys process when the
v2 n8n workflow should call Stripe. It defaults to false and does not expose
the Stripe secret.

`BOT_REACTIONS_ENABLED=true` enables reaction-first results. Clear valid and
failed/unclear results react to the original screenshot. Captionless valid
results also send a detailed reply containing the canonical Stripe-recovered
email so the group can see which customer was matched. Duplicate results
remain text replies so the bot can explain the original processing record.
`REQUIRE_EMAIL_CAPTION` is retained for compatibility but should be `false`:
the caption email is preferred evidence, not a prerequisite. Missing or
incorrect captions are recovered only from deterministic OCR evidence and one
eligible Stripe match; ambiguous evidence remains unconfirmed and reacts with
`⚠️`, never as an automatic fake/duplicate decision. An exact payment or
transaction identifier extracted from the screenshot is also used to select
the matching Stripe charge when it agrees with the eligible payment data.

## WhatsApp group access

WHATSAPP_ALLOWED_GROUP_JIDS=1234567890-1234567890@g.us,1234567890-9876543210@g.us

- This is an exact, comma-separated allowlist of group JIDs.
- Direct chats and all other groups are ignored before application processing.
- An empty allowlist is fail-closed: the bot can authenticate, but it will not process or reply to messages.
- `WHATSAPP_TEST_GROUP_JID` remains supported as a legacy single-group setting.
- The project is pinned to Baileys `7.0.0-rc14`; stop any old bot process before restarting after dependency changes.

## Stripe read-only verification

The verifier is server-side and read-only. It only performs paginated GET
requests for Customers and Charges. Keep the Stripe secret only in the OCR
service environment; n8n receives only `STRIPE_SERVICE_TOKEN`.

STRIPE_ENABLED=false
STRIPE_SECRET_KEY=
STRIPE_SERVICE_TOKEN=
# Must match the key prefix. Use test for development and live only for an
# explicitly approved production/live-data environment.
STRIPE_MODE=test
STRIPE_API_BASE_URL=https://api.stripe.com
STRIPE_API_VERSION=
STRIPE_TIMEOUT_SECONDS=15
STRIPE_TIMEZONE=UTC
# Optional timezone printed by payment receipts, e.g. America/Chicago.
# Leave empty for multi-group/multi-timezone operation; screenshot hour is then
# diagnostic only and cannot reject a match. Minutes and date remain filters.
STRIPE_SCREENSHOT_TIMEZONE=
STRIPE_MAX_PAGES=10
STRIPE_LOOKBACK_DAYS=90
STRIPE_ALLOWED_PAYMENT_METHOD_TYPE=cashapp
STRIPE_CACHE_TTL_SECONDS=10
STRIPE_CACHE_MAX_ENTRIES=512
STRIPE_REQUESTS_PER_SECOND=20
STRIPE_MAX_CONCURRENT_REQUESTS=5
STRIPE_RETRY_ATTEMPTS=2
STRIPE_BACKOFF_BASE_SECONDS=0.5
STRIPE_BACKOFF_MAX_SECONDS=8

Stripe reads are protected by a bounded in-memory cache, a process-wide
20-request/second scheduler, a five-request concurrency limit, and two
retries for transient failures. The cache is short-lived and never persisted;
it is an optimization only, so Stripe remains the source of truth. Keep the
same settings across service instances and use a shared distributed limiter
and cache before running multiple OCR-service processes.

When `STRIPE_MODE=test`, use standard `sk_test_` or restricted `rk_test_`
keys. For an explicitly approved live environment, set `STRIPE_MODE=live` and
use `sk_live_` or restricted `rk_live_`. Publishable `pk_` keys are never
accepted because this is a server-side API integration.

## Duplicate detection

The WhatsApp adapter persists duplicate metadata in
`DUPLICATE_STORE_PATH` (default `data/duplicate-store.json`) and never stores
the screenshot itself. `DUPLICATE_RETENTION_DAYS` controls metadata retention
and defaults to 90 days. Exact resends are detected by SHA-256 across all
allowlisted groups and bot restarts. Recompressed/resized copies are compared
with pHash only when the caption identity and OCR amount also agree. A
uniquely matched Stripe charge ID is independently claimed so the same
payment is marked duplicate even when the image changes.

Duplicate records retain the first-seen group-name snapshot when WhatsApp
metadata is available. Duplicate replies include the original processing ID,
the same-group or named-origin-group scope, and the detection proof: exact
image hash, visual pHash match, or repeated Stripe charge. If metadata lookup
fails, the reply safely falls back to a generic group/workspace description.
A WhatsApp delete event never releases a claim; deletion is not proof that a
payment may be safely reprocessed.

The file store is safe for one bot process handling many groups. If production
uses multiple bot processes or hosts, replace it with a shared transactional
store before rollout; otherwise two processes can claim the same image or
Stripe charge concurrently.

## Screenshot processing queue

The Baileys adapter uses a durable local queue at `PROCESSING_QUEUE_PATH`
(default `data/processing-queue.json`). The queue stores job metadata and the
serialized WhatsApp message needed to re-download media after a restart; it
does not permanently store screenshots. Completed and dead-letter records are
automatically bounded by age and count.

The default production-safe settings are:

```text
PROCESSING_QUEUE_CONCURRENCY=1
PROCESSING_QUEUE_MAX_PENDING=200
PROCESSING_QUEUE_MAX_ATTEMPTS=4
PROCESSING_QUEUE_BACKOFF_BASE_MS=5000
PROCESSING_QUEUE_BACKOFF_MAX_MS=300000
PROCESSING_QUEUE_COOLDOWN_MS=250
```

Jobs are processed in FIFO order within each group and scheduled fairly across
groups. Retryable failures remain queued with exponential backoff. Permanent
failures move to dead-letter review and receive a warning reaction; they are
never automatically labeled fake. A running job is recovered as queued when
the bot restarts. Run only one active Baileys bot instance for a given auth
directory and queue file.

The local queue is appropriate for one Droplet and one bot process. Before
running multiple bot or worker processes, replace it with a shared transactional
queue/ledger such as Redis plus a shared database, and add a distributed lock.

For this verifier, restricted keys must have read-only access to Customers and
Charges. Never grant write permissions. The internal service token is required
on verification requests and must be configured in the n8n credential/request
header. Never place either secret in Baileys, n8n workflow exports, logs, or
WhatsApp messages.

Live mode reads real customer and payment data. Before enabling it, use a
dedicated allowlisted WhatsApp group, confirm the account and key are correct,
and keep the live secret out of source control and screenshots.

## Future Google Sheets

GOOGLE_SHEETS_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=

## Future Telegram

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

## Rules

- .env is never committed.
- .env.example contains names only.
- Do not put real credentials in documentation.
- AI provider keys are optional until that provider is active.

# ENVIRONMENT CONFIGURATION

Create .env locally from .env.example.

## Development

AI_PROVIDER=groq

GROQ_API_KEY=
GROQ_VISION_MODEL=qwen/qwen3.8-27b
GROQ_MAX_OUTPUT_TOKENS=512

GEMINI_API_KEY=
GEMINI_VISION_MODEL=

OCR_CONFIDENCE_THRESHOLD=0.85
CAPTION_ASSOCIATION_WINDOW_MS=2000

When a payment image has no attached caption, the WhatsApp adapter associates a
nearby email-only text message from the same group member, whether it arrived
immediately before or after the image. Only that narrow same-group/same-sender
correlation is allowed; arbitrary group messages are never used as payment
identity. Image captions may contain one email token plus additional context
such as an amount; multiple different addresses remain ambiguous.

N8N_BASE_URL=http://localhost:5678
N8N_WEBHOOK_PATH=/webhook/whatsapp-screenshot
N8N_HEALTH_TIMEOUT_MS=5000

LOG_LEVEL=INFO

`STRIPE_VERIFICATION_ENABLED=true` is required in the Baileys process when the
v2 n8n workflow should call Stripe. It defaults to false and does not expose
the Stripe secret.

`BOT_REACTIONS_ENABLED=true` enables reaction-first results. Clear valid and
failed/unclear results react to the original screenshot. `✅` is reserved for
a unique eligible Stripe match; every non-duplicate non-valid result uses
`❌` and, when bot replies are enabled, includes a concise explanation.
Captionless valid results and valid results whose caption identity was
corrected by Stripe also send a detailed reply containing the canonical
Stripe-recovered email so the group can see which customer was matched.
When the caption is absent, the reply explicitly says so and shows a masked
Stripe email and masked identifiers, together with the verified amount, time,
status, payment method, customer name when present, and description. It never
uses an OCR guess as a verified identity or publishes raw Stripe objects.
Duplicate results remain text replies so the bot can explain the original
processing record. Ambiguous Stripe results remain review-only, but now include
the sanitized eligible candidate records in newest-first order so the client
can decide without opening Stripe manually. No candidate in that report is
claimed or approved automatically.
`REQUIRE_EMAIL_CAPTION` is retained for compatibility but should be `false`:
the caption email is preferred evidence, not a prerequisite. Missing or
incorrect captions are recovered only from deterministic OCR evidence and one
eligible Stripe match; ambiguous evidence remains unconfirmed and reacts with
`❌`, never as an automatic fake accusation. The n8n workflow preserves both
the caption email and any distinct OCR-visible email as candidates. Stripe
selects the unique eligible charge and its canonical customer email; the
caption is never used to overwrite that Stripe identity. An exact payment or
transaction identifier extracted from the screenshot is also used to select
the matching Stripe charge when it agrees with the eligible payment data.

## WhatsApp group access

WHATSAPP_ALLOWED_GROUP_JIDS=1234567890-1234567890@g.us,1234567890-9876543210@g.us

- This is an exact, comma-separated allowlist of group JIDs.
- Direct chats and all other groups are ignored before application processing.
- An empty allowlist is fail-closed: the bot can authenticate, but it will not process or reply to messages.
- `WHATSAPP_TEST_GROUP_JID` remains supported as a legacy single-group setting.
- The project is pinned to Baileys `7.0.0-rc14`; stop any old bot process before restarting after dependency changes.
- `BOT_LOCK_PATH` is a local PID marker that prevents two bot processes from
  sharing the same Baileys auth state and processing queue. Keep one bot
  instance per auth directory; a stale marker is recovered automatically when
  its recorded PID is no longer running.
- `PAYMENT_REVIEW_ADMIN_JIDS` is an optional comma-separated list of direct
  WhatsApp JIDs such as `923001234567@s.whatsapp.net` or `...@lid`. For
  ambiguous Stripe matches, the bot sends the complete sanitized candidate
  proof, including unmasked Stripe email and IDs, only to these private
  recipients. Group replies remain privacy-safe and review-only. Group JIDs
  are rejected by configuration validation.

## Stripe read-only verification

The verifier is server-side and read-only. It performs GET requests for
Customers and Charges, using Stripe Charges Search for amount-bearing
captionless receipts before falling back to a bounded list query when Search
is unavailable or temporarily empty. Keep the
Stripe secret only in the OCR service environment; n8n receives only
`STRIPE_SERVICE_TOKEN`.

STRIPE_ENABLED=false
STRIPE_SECRET_KEY=
STRIPE_SERVICE_TOKEN=
# Must match the key prefix. Use test for development and live only for an
# explicitly approved production/live-data environment.
STRIPE_MODE=test
STRIPE_API_BASE_URL=https://api.stripe.com
STRIPE_API_VERSION=
STRIPE_TIMEOUT_SECONDS=15
# Stripe dashboard/account timestamps are US Central in this deployment.
STRIPE_TIMEZONE=America/Chicago
# Optional timezone printed by payment receipts, e.g. America/Chicago. Set this
# when receipt clocks use the same timezone as the Stripe account. It allows
# hour+minute matching. If an exact hour window returns no match, the verifier
# performs bounded recovery that can cross a date boundary, but still requires
# amount, exact receipt minute, status, currency, payment method, and one
# strong identity/name/description constraint. It approves only one eligible
# charge (or one fresh charge after previously claimed IDs are removed). Leave
# empty for mixed receipt zones.
STRIPE_SCREENSHOT_TIMEZONE=
# A receipt saying "Today" is resolved from the WhatsApp receive timestamp in
# STRIPE_TIMEZONE by the n8n evidence-preparation node. This avoids scanning
# the whole account for a current-day captionless payment while keeping the
# final match anchored to Stripe's created timestamp.
# Email-based verification queries the Stripe customer (without an OCR-date
# restriction) first, then uses a bounded day/lookback scan only for recovery.
# This avoids rejecting valid receipts whose displayed date crosses a timezone
# boundary from Stripe's UTC-created timestamp.
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

When several eligible Stripe charges match the screenshot, the verifier
returns `candidate_transactions` for the WhatsApp review report. Candidate
order is for investigation convenience, not a recency-based approval rule. The
WhatsApp reply shows only the newest candidate as review context and keeps the
full count; it does not approve that candidate automatically. If receipt date
or month/day evidence exists, historical email/amount fallbacks cannot ignore
it. The bot approves only one uniquely proven charge, including a bounded
timezone-boundary match with strong identity evidence. The full sanitized
candidate set is sent only to `PAYMENT_REVIEW_ADMIN_JIDS`; there is no safe
automatic approval when multiple fresh candidates remain.

## Duplicate detection

The WhatsApp adapter persists duplicate metadata in
`DUPLICATE_STORE_PATH` (default `data/duplicate-store.json`) and never stores
the screenshot itself. `DUPLICATE_RETENTION_DAYS` controls metadata retention
and defaults to 90 days. Exact resends are detected by SHA-256 across all
allowlisted groups and bot restarts. A repeated exact image is non-approving
even when the earlier attempt was unresolved; the reply identifies the
original processing record and says that the original attempt was not
approved. This prevents a retry of the same bytes from becoming a second
approval while still preserving the first unresolved record for review.
Recompressed/resized copies are compared with a normalized payment-evidence
fingerprint first when the receipt contains the same payment-specific
transaction identifier. If OCR cannot read that identifier, pHash may be used
only with the same customer name, amount, and complete receipt date/time, or
with a strict visual receipt fingerprint, exact pHash equality, and the same
amount and complete receipt date/time when OCR has misread the identifier;
email, amount, and displayed time alone are not duplicate proof because one
customer can make multiple same-amount payments in the same minute. When Stripe resolves both
copies, the canonical charge ID remains the strongest proof. If a visually
equivalent image resolves to a different Stripe charge, it is blocked as
`UNCLEAR` for review rather than automatically approved. A current attempt
that is the first one to obtain a fresh Stripe charge remains eligible for
that single approval; it is not suppressed merely because an earlier attempt
was unresolved.

Duplicate records retain the first-seen group-name snapshot when WhatsApp
metadata is available. Duplicate replies include the original processing ID,
the same-group or named-origin-group scope, and the detection proof: exact
image hash, visual pHash match, or repeated Stripe charge. If metadata lookup
fails, the reply safely falls back to a generic group/workspace description.
A duplicate image or repeated Stripe charge also gets a quoted reference to
the original WhatsApp message when its message key is still addressable; this
annotation preserves the original result and does not silently re-approve or
reclassify it. A WhatsApp delete event never releases a claim; deletion is not
proof that a payment may be safely reprocessed.

The file store is safe for one bot process handling many groups. If production
uses multiple bot processes or hosts, replace it with a shared transactional
store before rollout; otherwise two processes can claim the same image or
Stripe charge concurrently.

The claimed Stripe-charge recovery list is rebuilt from both the transaction
claim ledger and persisted image evidence marked `VALID`. This preserves
multi-match recovery after a restart or when an older valid record did not
populate the newer transaction ledger. Only a canonical charge attached to an
explicitly valid result is reused; review, error, and unresolved records never
exclude a candidate or create an approval.

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
failures move to dead-letter review and receive a cross reaction plus a concise
justification; they are never automatically labeled fake. A running job is recovered as queued when
the bot restarts. Run only one active Baileys bot instance for a given auth
directory and queue file.

When Baileys delivers several messages in one update, the adapter performs the
short nearby-email association waits concurrently so a 50-group burst is not
delayed by 50 sequential timers. The expensive OCR/Stripe pipeline remains a
single worker by default, preserving ordered, safe file-backed state. Monitor
the structured `Incoming image queued`, `Processing queue job completed`, and
`Message processing complete` logs for queue depth, duration, retries, and
verification outcomes.

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

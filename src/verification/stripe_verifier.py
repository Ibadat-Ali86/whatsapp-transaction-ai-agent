"""Read-only, mode-aware Stripe transaction verification.

The caption email is a preferred identity, not a trust boundary. When it is
missing or does not identify a matching charge, deterministic screenshot
evidence can recover the Stripe customer only when it yields one unambiguous
eligible charge. Ambiguous or insufficient evidence is never approved.
"""

from __future__ import annotations

import hashlib
import asyncio
import copy
import random
import re
import time as monotonic_time
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta, timezone
from collections import OrderedDict
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from src.logging.audit import AuditLogger


EMAIL_PATTERN = re.compile(
    r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
    r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$"
)
TRANSACTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$")
TRANSACTION_METADATA_KEYS = {
    "transaction_id",
    "transactionid",
    "payment_id",
    "payment_identifier",
    "cash_app_payment_id",
    "cashapp_payment_id",
    "cashapp_transaction_id",
    "external_transaction_id",
    "receipt_id",
}


@dataclass(frozen=True)
class PaymentEvidence:
    email: Optional[str] = None
    # The primary email is normally the WhatsApp caption. Additional
    # syntactically valid identities (for example, an email visible inside
    # the receipt) remain available as independent lookup candidates so a
    # mistyped caption cannot hide the canonical Stripe customer.
    email_candidates: tuple[str, ...] = ()
    transaction_id: Optional[str] = None
    # Optional exact Stripe description/reference supplied by trusted evidence.
    # The current receipt format does not expose it, so normal verification
    # must not require it; a dashboard-only description cannot be inferred
    # from amount and email.
    description: Optional[str] = None
    # Optional receipt customer name used only as a deterministic
    # disambiguator when email/amount/time leave multiple Stripe charges.
    customer_name: Optional[str] = None
    amount_cents: Optional[int] = None
    payment_date: Optional[date] = None
    minutes: Optional[int] = None
    payment_hour: Optional[int] = None
    payment_month: Optional[int] = None
    payment_day: Optional[int] = None
    # Stripe charge IDs already claimed by the single WhatsApp worker. They
    # are used only to resolve a multi-match when exactly one fresh charge
    # remains; a sole claimed match is intentionally preserved so the Node
    # layer can report it as a duplicate transaction.
    excluded_stripe_charge_ids: tuple[str, ...] = ()
    currency: str = "usd"
    payment_method_type: str = "cashapp"


@dataclass(frozen=True)
class StripeVerificationResult:
    processing_id: str
    status: str
    verdict: str
    reason_code: str
    stripe_charge_id: Optional[str] = None
    candidate_count: int = 0
    email_hash: Optional[str] = None
    retryable: bool = False
    matched_transaction: Optional[dict[str, Any]] = None

    def as_dict(self) -> dict[str, Any]:
        result = {
            "processing_id": self.processing_id,
            "provider": "stripe",
            "status": self.status,
            "verdict": self.verdict,
            "reason_code": self.reason_code,
            "stripe_charge_id": self.stripe_charge_id,
            "candidate_count": self.candidate_count,
            "email_hash": self.email_hash,
            "retryable": self.retryable,
        }
        if self.matched_transaction is not None:
            result["matched_transaction"] = self.matched_transaction
        return result


class StripeVerificationError(Exception):
    def __init__(
        self,
        reason_code: str,
        retryable: bool = False,
        retry_after_seconds: Optional[float] = None,
    ):
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds


@dataclass
class _CacheEntry:
    value: dict[str, Any]
    expires_at: float


class StripeResponseCache:
    """Bounded, short-lived cache for successful Stripe GET responses.

    Stripe payment data can change shortly after creation, so this is a
    freshness optimization rather than a source of truth. The cache is kept
    in memory and scoped to one OCR-service process; it never persists payment
    data to disk.
    """

    def __init__(self, ttl_seconds: float = 10.0, max_entries: int = 512):
        self.ttl_seconds = max(0.0, float(ttl_seconds))
        self.max_entries = max(1, int(max_entries))
        self._entries: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> Optional[dict[str, Any]]:
        if self.ttl_seconds <= 0:
            return None
        now = monotonic_time.monotonic()
        async with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if entry.expires_at <= now:
                self._entries.pop(key, None)
                return None
            self._entries.move_to_end(key)
            return copy.deepcopy(entry.value)

    async def set(self, key: str, value: dict[str, Any]) -> None:
        if self.ttl_seconds <= 0:
            return
        async with self._lock:
            self._entries[key] = _CacheEntry(
                value=copy.deepcopy(value),
                expires_at=monotonic_time.monotonic() + self.ttl_seconds,
            )
            self._entries.move_to_end(key)
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)


class StripeRequestLimiter:
    """Process-wide spacing and concurrency controls for Stripe requests."""

    def __init__(self, requests_per_second: float = 20.0, max_concurrent: int = 5):
        self.requests_per_second = max(0.0, float(requests_per_second))
        self.interval_seconds = 1.0 / self.requests_per_second if self.requests_per_second else 0.0
        self._next_request_at = 0.0
        self._schedule_lock = asyncio.Lock()
        self._concurrency = asyncio.Semaphore(max(1, int(max_concurrent)))

    async def acquire(self) -> None:
        if self.interval_seconds <= 0:
            return
        async with self._schedule_lock:
            now = monotonic_time.monotonic()
            scheduled_at = max(now, self._next_request_at)
            self._next_request_at = scheduled_at + self.interval_seconds
        delay = scheduled_at - now
        if delay > 0:
            await asyncio.sleep(delay)

    async def __aenter__(self):
        await self._concurrency.acquire()
        await self.acquire()
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback):
        self._concurrency.release()


class StripeVerificationRuntime:
    """Shared per-account controls reused by concurrent verification requests."""

    def __init__(
        self,
        *,
        cache_ttl_seconds: float = 10.0,
        cache_max_entries: int = 512,
        requests_per_second: float = 20.0,
        max_concurrent_requests: int = 5,
    ):
        self.cache = StripeResponseCache(cache_ttl_seconds, cache_max_entries)
        self.request_limiter = StripeRequestLimiter(requests_per_second, max_concurrent_requests)


def normalize_email(value: str) -> str:
    normalized = value.strip().casefold()
    if not EMAIL_PATTERN.fullmatch(normalized):
        raise ValueError("invalid email")
    return normalized


def normalize_transaction_id(value: str) -> str:
    normalized = value.strip()
    if not TRANSACTION_ID_PATTERN.fullmatch(normalized):
        raise ValueError("invalid transaction id")
    return normalized


def normalize_description(value: str) -> str:
    normalized = " ".join(value.strip().split())
    if not normalized or len(normalized) > 1000:
        raise ValueError("invalid description")
    return normalized.casefold()


def normalize_customer_name(value: str) -> str:
    normalized = " ".join(value.strip().split()).casefold()
    if not normalized or len(normalized) > 256:
        raise ValueError("invalid customer name")
    return normalized


def _email_hash(email: Optional[str]) -> Optional[str]:
    if not email:
        return None
    return hashlib.sha256(email.encode("utf-8")).hexdigest()[:16]


def _local_day_bounds(payment_date: date, timezone_name: str) -> tuple[int, int, ZoneInfo]:
    try:
        zone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("invalid Stripe timezone configuration") from exc

    start = datetime.combine(payment_date, time.min, tzinfo=zone)
    end = datetime.combine(payment_date + timedelta(days=1), time.min, tzinfo=zone) - timedelta(seconds=1)
    return int(start.timestamp()), int(end.timestamp()), zone


def _charge_local_datetime(charge: dict[str, Any], zone: ZoneInfo) -> Optional[datetime]:
    created = charge.get("created")
    if not isinstance(created, (int, float)):
        return None
    return datetime.fromtimestamp(created, tz=timezone.utc).astimezone(zone)


class StripeVerifier:
    def __init__(
        self,
        secret_key: str,
        *,
        mode: str = "test",
        base_url: str = "https://api.stripe.com",
        api_version: str = "",
        timeout_seconds: float = 15.0,
        timezone_name: str = "UTC",
        screenshot_timezone: str = "",
        max_pages: int = 10,
        lookback_days: int = 90,
        allowed_payment_method_type: str = "cashapp",
        cache_ttl_seconds: float = 10.0,
        cache_max_entries: int = 512,
        requests_per_second: float = 20.0,
        max_concurrent_requests: int = 5,
        retry_attempts: int = 2,
        backoff_base_seconds: float = 0.5,
        backoff_max_seconds: float = 8.0,
        runtime: Optional[StripeVerificationRuntime] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        audit_logger: Optional[AuditLogger] = None,
    ):
        self.secret_key = secret_key
        self.mode = mode.strip().casefold()
        self.base_url = base_url.rstrip("/")
        self.api_version = api_version
        self.timeout_seconds = timeout_seconds
        self.timezone_name = timezone_name
        self.screenshot_timezone = screenshot_timezone.strip()
        self.max_pages = max_pages
        self.lookback_days = lookback_days
        self.allowed_payment_method_type = allowed_payment_method_type.casefold()
        self.cache_ttl_seconds = cache_ttl_seconds
        self.cache_max_entries = cache_max_entries
        self.requests_per_second = requests_per_second
        self.max_concurrent_requests = max_concurrent_requests
        self.retry_attempts = retry_attempts
        self.backoff_base_seconds = backoff_base_seconds
        self.backoff_max_seconds = backoff_max_seconds
        self.runtime = runtime or StripeVerificationRuntime(
            cache_ttl_seconds=cache_ttl_seconds,
            cache_max_entries=cache_max_entries,
            requests_per_second=requests_per_second,
            max_concurrent_requests=max_concurrent_requests,
        )
        self._cache_namespace = hashlib.sha256(secret_key.encode("utf-8")).hexdigest()[:16]
        self.http_client = http_client
        self.audit_logger = audit_logger or AuditLogger("stripe_verifier")

    def _validate_configuration(self) -> None:
        if self.mode not in {"test", "live"}:
            raise StripeVerificationError("STRIPE_MODE_INVALID")
        if not self.secret_key:
            raise StripeVerificationError("STRIPE_SECRET_KEY_MISSING")
        allowed_prefixes = (f"sk_{self.mode}_", f"rk_{self.mode}_")
        if not self.secret_key.startswith(allowed_prefixes):
            reason_code = (
                "STRIPE_TEST_SECRET_REQUIRED"
                if self.mode == "test"
                else "STRIPE_LIVE_SECRET_REQUIRED"
            )
            raise StripeVerificationError(reason_code)
        if self.max_pages < 1 or self.max_pages > 100:
            raise StripeVerificationError("STRIPE_MAX_PAGES_INVALID")
        if self.lookback_days < 1 or self.lookback_days > 3650:
            raise StripeVerificationError("STRIPE_LOOKBACK_DAYS_INVALID")
        if self.cache_ttl_seconds < 0 or self.cache_ttl_seconds > 3600:
            raise StripeVerificationError("STRIPE_CACHE_TTL_INVALID")
        if self.cache_max_entries < 1 or self.cache_max_entries > 10000:
            raise StripeVerificationError("STRIPE_CACHE_MAX_ENTRIES_INVALID")
        if self.requests_per_second < 0 or self.requests_per_second > 100:
            raise StripeVerificationError("STRIPE_REQUESTS_PER_SECOND_INVALID")
        if self.max_concurrent_requests < 1 or self.max_concurrent_requests > 100:
            raise StripeVerificationError("STRIPE_MAX_CONCURRENT_REQUESTS_INVALID")
        if self.retry_attempts < 0 or self.retry_attempts > 5:
            raise StripeVerificationError("STRIPE_RETRY_ATTEMPTS_INVALID")
        if self.backoff_base_seconds < 0 or self.backoff_base_seconds > 60:
            raise StripeVerificationError("STRIPE_BACKOFF_BASE_INVALID")
        if self.backoff_max_seconds < 0 or self.backoff_max_seconds > 300:
            raise StripeVerificationError("STRIPE_BACKOFF_MAX_INVALID")
        if self.backoff_max_seconds < self.backoff_base_seconds:
            raise StripeVerificationError("STRIPE_BACKOFF_RANGE_INVALID")

    def _cache_key(self, path: str, params: dict[str, Any]) -> str:
        normalized_params = "&".join(
            f"{key}={params[key]}" for key in sorted(params)
        )
        return f"{self._cache_namespace}|{self.base_url}|{self.api_version}|{path}?{normalized_params}"

    @staticmethod
    def _retry_after_seconds(response: httpx.Response) -> Optional[float]:
        value = response.headers.get("retry-after")
        if value is None:
            return None
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        return max(0.0, min(parsed, 300.0))

    def _backoff_seconds(self, attempt: int, retry_after_seconds: Optional[float]) -> float:
        if retry_after_seconds is not None:
            return retry_after_seconds
        upper_bound = min(
            self.backoff_max_seconds,
            self.backoff_base_seconds * (2 ** attempt),
        )
        return random.uniform(0.0, upper_bound) if upper_bound > 0 else 0.0

    async def _get_once(self, client: httpx.AsyncClient, path: str, params: dict[str, Any]) -> dict[str, Any]:
        headers = {"accept": "application/json"}
        if self.api_version:
            headers["Stripe-Version"] = self.api_version

        try:
            async with self.runtime.request_limiter:
                response = await client.get(
                    f"{self.base_url}{path}",
                    params=params,
                    headers=headers,
                    auth=(self.secret_key, ""),
                )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise StripeVerificationError("STRIPE_NETWORK_ERROR", retryable=True) from exc

        if response.status_code >= 400:
            retryable = response.status_code == 429 or response.status_code >= 500
            reason = "STRIPE_RATE_LIMITED" if response.status_code == 429 else "STRIPE_API_ERROR"
            raise StripeVerificationError(
                reason,
                retryable=retryable,
                retry_after_seconds=self._retry_after_seconds(response) if response.status_code == 429 else None,
            )

        try:
            body = response.json()
        except ValueError as exc:
            raise StripeVerificationError("STRIPE_INVALID_RESPONSE", retryable=True) from exc
        if not isinstance(body, dict):
            raise StripeVerificationError("STRIPE_INVALID_RESPONSE", retryable=True)
        return body

    async def _get(self, client: httpx.AsyncClient, path: str, params: dict[str, Any]) -> dict[str, Any]:
        cache_key = self._cache_key(path, params)
        cached = await self.runtime.cache.get(cache_key)
        if cached is not None:
            return cached

        for attempt in range(self.retry_attempts + 1):
            try:
                body = await self._get_once(client, path, params)
                await self.runtime.cache.set(cache_key, body)
                return body
            except StripeVerificationError as exc:
                if not exc.retryable or attempt >= self.retry_attempts:
                    raise
                await asyncio.sleep(self._backoff_seconds(attempt, exc.retry_after_seconds))

        raise StripeVerificationError("STRIPE_REQUEST_RETRY_EXHAUSTED", retryable=True)

    async def _customer_ids(self, client: httpx.AsyncClient, email: str) -> set[str]:
        ids: set[str] = set()
        starting_after: Optional[str] = None

        for _ in range(self.max_pages):
            params: dict[str, Any] = {"email": email, "limit": 100}
            if starting_after:
                params["starting_after"] = starting_after
            body = await self._get(client, "/v1/customers", params)
            page = body.get("data", [])
            if not isinstance(page, list):
                raise StripeVerificationError("STRIPE_INVALID_RESPONSE", retryable=True)

            for customer in page:
                if not isinstance(customer, dict):
                    continue
                customer_email = customer.get("email")
                if isinstance(customer_email, str) and customer_email.casefold() == email:
                    customer_id = customer.get("id")
                    if isinstance(customer_id, str):
                        ids.add(customer_id)

            if not body.get("has_more"):
                return ids
            if not page or not isinstance(page[-1].get("id"), str):
                raise StripeVerificationError("STRIPE_INVALID_PAGINATION", retryable=True)
            starting_after = page[-1]["id"]

        raise StripeVerificationError("STRIPE_PAGINATION_LIMIT", retryable=False)

    async def _customer_ids_for_emails(
        self,
        client: httpx.AsyncClient,
        emails: set[str],
    ) -> set[str]:
        customer_ids: set[str] = set()
        for email in sorted(emails):
            customer_ids.update(await self._customer_ids(client, email))
        return customer_ids

    async def _customer_email(self, client: httpx.AsyncClient, customer_id: str) -> Optional[str]:
        body = await self._get(client, f"/v1/customers/{customer_id}", {})
        email = body.get("email")
        if isinstance(email, str) and email.strip():
            return email.strip().casefold()
        return None

    async def _charges_for_day(
        self,
        client: httpx.AsyncClient,
        start_timestamp: int,
        end_timestamp: int,
    ) -> list[dict[str, Any]]:
        charges: list[dict[str, Any]] = []
        starting_after: Optional[str] = None

        for _ in range(self.max_pages):
            params: dict[str, Any] = {
                "created[gte]": start_timestamp,
                "created[lte]": end_timestamp,
                "limit": 100,
            }
            if starting_after:
                params["starting_after"] = starting_after

            body = await self._get(client, "/v1/charges", params)
            page = body.get("data", [])
            if not isinstance(page, list):
                raise StripeVerificationError("STRIPE_INVALID_RESPONSE", retryable=True)
            charges.extend(item for item in page if isinstance(item, dict))

            if not body.get("has_more"):
                return charges
            if not page or not isinstance(page[-1].get("id"), str):
                raise StripeVerificationError("STRIPE_INVALID_PAGINATION", retryable=True)
            starting_after = page[-1]["id"]

        raise StripeVerificationError("STRIPE_PAGINATION_LIMIT", retryable=False)

    async def _charges_for_search(
        self,
        client: httpx.AsyncClient,
        query: str,
    ) -> list[dict[str, Any]]:
        """Search a narrowed charge set without walking the account ledger.

        Captionless receipts commonly provide only amount and receipt time.
        Listing every charge in a large live account is both expensive and
        bounded by ``max_pages``. Stripe's search endpoint lets us constrain
        the server-side result set before applying the verifier's stricter
        local checks (receipt email, payment method, minute, and timezone).
        """
        charges: list[dict[str, Any]] = []
        page_cursor: Optional[str] = None

        for _ in range(self.max_pages):
            params: dict[str, Any] = {"query": query, "limit": 100}
            if page_cursor:
                params["page"] = page_cursor

            body = await self._get(client, "/v1/charges/search", params)
            page = body.get("data", [])
            if not isinstance(page, list):
                raise StripeVerificationError("STRIPE_INVALID_RESPONSE", retryable=True)
            charges.extend(item for item in page if isinstance(item, dict))

            if not body.get("has_more"):
                return charges
            page_cursor = body.get("next_page")
            if not isinstance(page_cursor, str) or not page_cursor:
                raise StripeVerificationError("STRIPE_INVALID_PAGINATION", retryable=True)

        raise StripeVerificationError("STRIPE_PAGINATION_LIMIT", retryable=False)

    def _charge_search_query(
        self,
        evidence: PaymentEvidence,
        *,
        lower_timestamp: int,
        upper_timestamp: Optional[int] = None,
    ) -> Optional[str]:
        """Build a server-side query for evidence that has an exact amount."""
        if evidence.amount_cents is None:
            return None
        # Stripe Search supports exact numeric/token clauses. The local
        # matcher remains authoritative because Search cannot express every
        # verifier rule (receipt_email, payment method details, minute, etc.).
        query = (
            f"amount:{evidence.amount_cents} "
            f"AND currency:\"{evidence.currency}\" "
            f"AND status:\"succeeded\" "
            f"AND created>{max(0, lower_timestamp - 1)}"
        )
        if upper_timestamp is not None:
            query += f" AND created<{max(lower_timestamp, upper_timestamp) + 1}"
        return query

    async def _charges_for_customers(
        self,
        client: httpx.AsyncClient,
        customer_ids: set[str],
    ) -> list[dict[str, Any]]:
        charges: list[dict[str, Any]] = []
        seen_charge_ids: set[str] = set()

        for customer_id in customer_ids:
            starting_after: Optional[str] = None
            for _ in range(self.max_pages):
                params: dict[str, Any] = {"customer": customer_id, "limit": 100}
                if starting_after:
                    params["starting_after"] = starting_after

                body = await self._get(client, "/v1/charges", params)
                page = body.get("data", [])
                if not isinstance(page, list):
                    raise StripeVerificationError("STRIPE_INVALID_RESPONSE", retryable=True)

                for item in page:
                    if not isinstance(item, dict):
                        continue
                    charge_id = item.get("id")
                    if not isinstance(charge_id, str) or charge_id not in seen_charge_ids:
                        charges.append(item)
                        if isinstance(charge_id, str):
                            seen_charge_ids.add(charge_id)

                if not body.get("has_more"):
                    break
                if not page or not isinstance(page[-1].get("id"), str):
                    raise StripeVerificationError("STRIPE_INVALID_PAGINATION", retryable=True)
                starting_after = page[-1]["id"]
            else:
                raise StripeVerificationError("STRIPE_PAGINATION_LIMIT", retryable=False)

        return charges

    async def _charges_for_lookback(
        self,
        client: httpx.AsyncClient,
    ) -> list[dict[str, Any]]:
        """Load a bounded recent charge window for receipt-email matching.

        Some Stripe charges expose the payer email as ``receipt_email`` but do
        not have a Customer ID.  A customer-scoped list cannot return those
        charges, so the caller uses this bounded fallback after that search
        produces no eligible match.
        """
        # Keep the moving lookback query stable for one short cache bucket;
        # using the exact current second would defeat response caching.
        now_timestamp = int(datetime.now(timezone.utc).timestamp()) // 10 * 10
        return await self._charges_for_day(
            client,
            now_timestamp - int(timedelta(days=self.lookback_days).total_seconds()),
            now_timestamp,
        )

    @staticmethod
    def _charge_email(charge: dict[str, Any]) -> Optional[str]:
        receipt_email = charge.get("receipt_email")
        if isinstance(receipt_email, str) and receipt_email.strip():
            return receipt_email.strip().casefold()
        billing_details = charge.get("billing_details")
        if isinstance(billing_details, dict) and isinstance(billing_details.get("email"), str):
            return billing_details["email"].strip().casefold()
        return None

    @staticmethod
    def _charge_customer_name(charge: dict[str, Any]) -> Optional[str]:
        billing_details = charge.get("billing_details")
        if isinstance(billing_details, dict) and isinstance(billing_details.get("name"), str):
            value = " ".join(billing_details["name"].split()).casefold()
            return value or None
        return None

    @classmethod
    def _customer_name_matches(cls, charge: dict[str, Any], evidence: PaymentEvidence) -> bool:
        if not evidence.customer_name:
            return False
        charge_name = cls._charge_customer_name(charge)
        return bool(charge_name and charge_name == evidence.customer_name)

    @staticmethod
    def _charge_transaction_ids(charge: dict[str, Any]) -> set[str]:
        """Return explicit provider/reference IDs exposed on a Stripe charge."""
        values: set[str] = set()

        def add(value: Any) -> None:
            if isinstance(value, str) and value.strip():
                values.add(value.strip().casefold())

        for key in ("id", "payment_intent", "balance_transaction", "receipt_number"):
            value = charge.get(key)
            add(value.get("id") if isinstance(value, dict) else value)

        source = charge.get("source")
        if isinstance(source, dict):
            add(source.get("id"))
        else:
            add(source)

        payment_method_details = charge.get("payment_method_details")
        if isinstance(payment_method_details, dict):
            cashapp = payment_method_details.get("cashapp")
            if isinstance(cashapp, dict):
                add(cashapp.get("transaction_id"))
                add(cashapp.get("payment_id"))

        metadata = charge.get("metadata")
        if isinstance(metadata, dict):
            for key, value in metadata.items():
                if str(key).casefold() in TRANSACTION_METADATA_KEYS:
                    add(value)
        return values

    @classmethod
    def _transaction_id_matches(cls, charge: dict[str, Any], evidence: PaymentEvidence) -> bool:
        if not evidence.transaction_id:
            return False
        return evidence.transaction_id.casefold() in cls._charge_transaction_ids(charge)

    def _matches(
        self,
        charge: dict[str, Any],
        evidence: PaymentEvidence,
        customer_ids: set[str],
        zone: ZoneInfo,
        *,
        require_identity: bool,
        include_time_constraints: bool,
        match_hour: bool = True,
        match_minute: bool = False,
    ) -> bool:
        if require_identity:
            charge_email = self._charge_email(charge)
            customer_id = charge.get("customer")
            identity_emails = {
                value.casefold()
                for value in (evidence.email, *evidence.email_candidates)
                if isinstance(value, str) and value
            }
            email_matches = charge_email in identity_emails or customer_id in customer_ids
            if not email_matches:
                return False

        if evidence.amount_cents is not None and charge.get("amount") != evidence.amount_cents:
            return False
        if evidence.description is not None:
            charge_description = charge.get("description")
            if not isinstance(charge_description, str):
                return False
            if normalize_description(charge_description) != evidence.description:
                return False
        if str(charge.get("currency", "")).casefold() != evidence.currency:
            return False
        if charge.get("paid") is not True or charge.get("refunded") is True:
            return False
        if charge.get("status") != "succeeded":
            return False

        payment_method_details = charge.get("payment_method_details")
        if self.allowed_payment_method_type:
            if not isinstance(payment_method_details, dict):
                return False
            payment_method_type = payment_method_details.get("type")
            if not isinstance(payment_method_type, str) or payment_method_type.casefold() != self.allowed_payment_method_type:
                return False

        if include_time_constraints:
            local_created = _charge_local_datetime(charge, zone)
            if local_created is None:
                return False
            if evidence.payment_date is not None and local_created.date() != evidence.payment_date:
                return False
            if evidence.payment_month is not None and local_created.month != evidence.payment_month:
                return False
            if evidence.payment_day is not None and local_created.day != evidence.payment_day:
                return False
            if evidence.minutes is not None and local_created.minute != evidence.minutes:
                return False
            if match_hour and evidence.payment_hour is not None and local_created.hour != evidence.payment_hour:
                return False
        elif match_minute and evidence.minutes is not None:
            local_created = _charge_local_datetime(charge, zone)
            if local_created is None or local_created.minute != evidence.minutes:
                return False
        return True

    @staticmethod
    def _transaction_details(charge: dict[str, Any], zone: ZoneInfo) -> Optional[dict[str, Any]]:
        local_created = _charge_local_datetime(charge, zone)
        if local_created is None:
            return None

        payment_method_details = charge.get("payment_method_details")
        payment_method_type = None
        if isinstance(payment_method_details, dict):
            payment_method_type = payment_method_details.get("type")

        billing_details = charge.get("billing_details")
        customer_name = None
        customer_email = None
        if isinstance(billing_details, dict) and isinstance(billing_details.get("name"), str):
            customer_name = billing_details["name"]
        customer_email = StripeVerifier._charge_email(charge)

        return {
            "amount_cents": charge.get("amount"),
            "currency": charge.get("currency"),
            "payment_date": local_created.date().isoformat(),
            "payment_hour": local_created.hour,
            "minutes": local_created.minute,
            "payment_time": local_created.strftime("%H:%M"),
            "customer_name": customer_name,
            "customer_email": customer_email,
            "description": charge.get("description") if isinstance(charge.get("description"), str) else None,
            "status": "Completed" if charge.get("paid") is True and charge.get("status") == "succeeded" else charge.get("status"),
            "payment_method_type": payment_method_type,
        }

    def _evidence_constraint_count(self, evidence: PaymentEvidence) -> int:
        """Count independently enforceable recovery constraints.

        A partial month/day date is one constraint, not two. Screenshot hours
        are only enforceable when the receipt timezone is explicitly known;
        otherwise counting the hour could turn an ignored, timezone-sensitive
        field into a false confidence signal.
        """
        date_constraint = evidence.payment_date is not None or (
            evidence.payment_month is not None and evidence.payment_day is not None
        )
        return sum(
            (
                evidence.amount_cents is not None,
                evidence.description is not None,
                evidence.customer_name is not None,
                date_constraint,
                evidence.minutes is not None,
                bool(self.screenshot_timezone) and evidence.payment_hour is not None,
            )
        )

    async def verify(self, evidence: PaymentEvidence, processing_id: str) -> StripeVerificationResult:
        try:
            normalized_email = None
            if evidence.email is not None and evidence.email.strip():
                normalized_email = normalize_email(evidence.email)
            normalized_email_candidates: list[str] = []
            for candidate in evidence.email_candidates:
                if candidate is None or not str(candidate).strip():
                    continue
                normalized_candidate = normalize_email(str(candidate))
                if normalized_candidate != normalized_email and normalized_candidate not in normalized_email_candidates:
                    normalized_email_candidates.append(normalized_candidate)
            normalized_transaction_id = None
            if evidence.transaction_id is not None and evidence.transaction_id.strip():
                normalized_transaction_id = normalize_transaction_id(evidence.transaction_id)
            normalized_description = None
            if evidence.description is not None and evidence.description.strip():
                normalized_description = normalize_description(evidence.description)
            normalized_excluded_charge_ids: list[str] = []
            for charge_id in evidence.excluded_stripe_charge_ids:
                if charge_id is None or not str(charge_id).strip():
                    continue
                try:
                    normalized_charge_id = normalize_transaction_id(str(charge_id))
                except ValueError:
                    continue
                if normalized_charge_id not in normalized_excluded_charge_ids:
                    normalized_excluded_charge_ids.append(normalized_charge_id)
            evidence = replace(
                evidence,
                email=normalized_email,
                email_candidates=tuple(normalized_email_candidates),
                transaction_id=normalized_transaction_id,
                description=normalized_description,
                excluded_stripe_charge_ids=tuple(normalized_excluded_charge_ids),
                currency=evidence.currency.casefold(),
                payment_method_type=evidence.payment_method_type.casefold(),
            )
        except (AttributeError, TypeError, ValueError):
            result = StripeVerificationResult(processing_id, "ERROR", "ERROR", "INVALID_EVIDENCE")
            self.audit_logger.log_verification(processing_id, result, safe_details="invalid_evidence")
            return result

        if self.allowed_payment_method_type and evidence.payment_method_type != self.allowed_payment_method_type:
            result = StripeVerificationResult(processing_id, "ERROR", "ERROR", "UNSUPPORTED_PAYMENT_METHOD_TYPE")
            self.audit_logger.log_verification(processing_id, result, safe_details="payment_method_policy")
            return result

        identity_emails = {
            value.casefold()
            for value in (evidence.email, *evidence.email_candidates)
            if isinstance(value, str) and value
        }
        email_hash = _email_hash(evidence.email)
        evidence_constraint_count = self._evidence_constraint_count(evidence)
        if not identity_emails and evidence_constraint_count < 2 and not evidence.transaction_id:
            result = StripeVerificationResult(
                processing_id,
                "NO_MATCH",
                "UNCLEAR",
                "INSUFFICIENT_STRIPE_EVIDENCE",
                email_hash=email_hash,
            )
            self.audit_logger.log_verification(processing_id, result, safe_details="insufficient_evidence")
            return result
        try:
            self._validate_configuration()
            try:
                zone = ZoneInfo(self.timezone_name)
                screenshot_zone = ZoneInfo(self.screenshot_timezone) if self.screenshot_timezone else None
            except ZoneInfoNotFoundError as exc:
                raise ValueError("invalid Stripe timezone configuration") from exc
            if evidence.payment_date is not None:
                query_timezone = self.screenshot_timezone or self.timezone_name
                start_timestamp, end_timestamp, _ = _local_day_bounds(evidence.payment_date, query_timezone)
            else:
                start_timestamp = end_timestamp = 0
            search_lower_timestamp = (
                start_timestamp
                if evidence.payment_date is not None
                else int(datetime.now(timezone.utc).timestamp()) - int(timedelta(days=self.lookback_days).total_seconds())
            )
            search_upper_timestamp = None
            if (
                evidence.payment_date is not None
                and screenshot_zone is not None
                and evidence.payment_hour is not None
                and evidence.minutes is not None
            ):
                minute_start = datetime.combine(
                    evidence.payment_date,
                    time(evidence.payment_hour, evidence.minutes),
                    tzinfo=screenshot_zone,
                )
                # Allow provider timestamp jitter around a displayed minute;
                # the local matcher below still requires the exact minute.
                search_lower_timestamp = int(minute_start.timestamp()) - 60
                search_upper_timestamp = int(minute_start.timestamp()) + 120
        except (StripeVerificationError, TypeError, ValueError) as exc:
            reason_code = exc.reason_code if isinstance(exc, StripeVerificationError) else str(exc)
            result = StripeVerificationResult(processing_id, "ERROR", "ERROR", reason_code, email_hash=email_hash)
            self.audit_logger.log_verification(processing_id, result, safe_details="configuration_error")
            return result

        owned_client = self.http_client is None
        client = self.http_client or httpx.AsyncClient(timeout=self.timeout_seconds)
        try:
            customer_ids = await self._customer_ids_for_emails(client, identity_emails) if identity_emails else set()
            # Prefer the strongest available Stripe-side identity constraint.
            # Do not apply the OCR date to this first customer-scoped query:
            # receipt dates can cross the Stripe-account timezone boundary, and
            # a valid customer charge must not be discarded before matching.
            if customer_ids:
                try:
                    charges = await self._charges_for_customers(client, customer_ids)
                except StripeVerificationError as exc:
                    if exc.reason_code != "STRIPE_PAGINATION_LIMIT":
                        raise
                    query = self._charge_search_query(
                        evidence,
                        lower_timestamp=search_lower_timestamp,
                        upper_timestamp=search_upper_timestamp,
                    )
                    if query is None:
                        raise
                    charges = await self._charges_for_search(client, query)
            elif evidence.amount_cents is not None:
                # Some Cash App/receipt payments have an email but no Stripe
                # Customer object. Search by exact amount and a bounded time
                # window instead of walking the account's entire charge list.
                query = self._charge_search_query(
                    evidence,
                    lower_timestamp=search_lower_timestamp,
                    upper_timestamp=search_upper_timestamp,
                )
                if query is None:
                    raise StripeVerificationError("INSUFFICIENT_STRIPE_EVIDENCE")
                try:
                    charges = await self._charges_for_search(client, query)
                except StripeVerificationError as exc:
                    # Search can be unavailable on older account API versions.
                    # Preserve a compatible, bounded fallback rather than
                    # turning that capability difference into a false result.
                    if exc.reason_code != "STRIPE_API_ERROR":
                        raise
                    charges = (
                        await self._charges_for_day(client, start_timestamp, end_timestamp)
                        if evidence.payment_date is not None
                        else await self._charges_for_lookback(client)
                    )
                if not charges:
                    # Stripe Search is eventually consistent. A just-created
                    # payment may be visible in the dashboard/list endpoint
                    # before it is indexed for Search. Retry through the
                    # bounded legacy list path; local eligibility matching is
                    # still authoritative and an empty/limited list never
                    # becomes an approval.
                    charges = (
                        await self._charges_for_day(client, start_timestamp, end_timestamp)
                        if evidence.payment_date is not None
                        else await self._charges_for_lookback(client)
                    )
            elif identity_emails:
                charges = await self._charges_for_lookback(client)
            elif evidence.payment_date is not None:
                charges = await self._charges_for_day(client, start_timestamp, end_timestamp)
            else:
                charges = await self._charges_for_lookback(client)
            match_zone = screenshot_zone or zone

            def matches_for(
                candidate_charges: list[dict[str, Any]],
                *,
                include_time_constraints: bool,
                match_hour: bool,
                match_minute: bool,
            ) -> list[dict[str, Any]]:
                return [
                    charge for charge in candidate_charges
                    if self._matches(
                        charge,
                        evidence,
                        customer_ids,
                        match_zone,
                        require_identity=bool(evidence.email),
                        include_time_constraints=include_time_constraints,
                        match_hour=match_hour,
                        match_minute=match_minute,
                    )
                ]

            excluded_charge_ids = set(evidence.excluded_stripe_charge_ids)

            def prefer_one_fresh_candidate(candidate_matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
                """Resolve only the safe case: multiple matches, one unused charge.

                A previously claimed charge must not hide a new eligible charge,
                but the verifier must still return a sole claimed match so the
                WhatsApp layer can classify the submission as a duplicate.
                Never choose arbitrarily when two or more fresh charges remain.
                """
                selected = candidate_matches
                if len(candidate_matches) > 1 and excluded_charge_ids:
                    fresh_matches = [
                        charge for charge in candidate_matches
                        if charge.get("id") not in excluded_charge_ids
                    ]
                    selected = fresh_matches if len(fresh_matches) == 1 else candidate_matches

                # A receipt customer name is independent of the caption email
                # and amount. Use it only to select one exact candidate from an
                # already eligible set; never use a fuzzy name match to approve
                # a payment or to discard an otherwise eligible candidate.
                if len(selected) > 1 and evidence.customer_name:
                    named_matches = [
                        charge for charge in selected
                        if self._customer_name_matches(charge, evidence)
                    ]
                    if len(named_matches) == 1:
                        return named_matches
                return selected

            matches = matches_for(
                charges,
                # Apply every trustworthy receipt constraint before deciding
                # that an email/amount pair is ambiguous.  The previous
                # customer-scoped path skipped date/hour and checked only the
                # minute, so two same-email/same-amount charges could survive
                # even when the screenshot contained a unique day and clock.
                # ``match_hour`` remains gated by the explicitly configured
                # receipt timezone; date/month-day/minute are safe local
                # constraints in either configuration.
                include_time_constraints=True,
                match_hour=bool(self.screenshot_timezone),
                match_minute=False,
            )
            matches = prefer_one_fresh_candidate(matches)

            # A receipt clock can differ from the Stripe account clock even
            # when the account dashboard is configured for US Central. If the
            # precise minute query produced no eligible match, widen only to
            # the same receipt date, then require the exact minute without
            # requiring the potentially shifted hour. This remains safe:
            # amount, date, minute, status, currency, and payment method must
            # still identify one eligible charge.
            if (
                not matches
                and not customer_ids
                and evidence.amount_cents is not None
                and evidence.payment_date is not None
                and search_upper_timestamp is not None
            ):
                day_query = self._charge_search_query(
                    evidence,
                    lower_timestamp=start_timestamp,
                    upper_timestamp=end_timestamp,
                )
                if day_query is not None:
                    try:
                        day_charges = await self._charges_for_search(client, day_query)
                    except StripeVerificationError as exc:
                        if exc.reason_code != "STRIPE_API_ERROR":
                            raise
                        day_charges = await self._charges_for_day(client, start_timestamp, end_timestamp)
                    if day_charges:
                        charges = day_charges
                        matches = matches_for(
                            charges,
                            include_time_constraints=not bool(evidence.email),
                            match_hour=bool(self.screenshot_timezone),
                            match_minute=bool(evidence.email),
                        )
                        if not matches and not evidence.email:
                            matches = matches_for(
                                charges,
                                include_time_constraints=True,
                                match_hour=False,
                                match_minute=False,
                            )
                        matches = prefer_one_fresh_candidate(matches)

            # Email identity plus the Stripe payment attributes is a safe
            # fallback when a receipt minute was OCR'd incorrectly or belongs
            # to a different display timezone. It only proceeds when the
            # identity/amount/status/payment-method match is unique.
            if not matches and identity_emails:
                # First tolerate only a date/hour conversion issue while
                # retaining the receipt minute. This resolves a valid charge
                # when the screenshot clock is in a nearby timezone without
                # jumping immediately to an email-only approval.
                matches = matches_for(
                    charges,
                    include_time_constraints=False,
                    match_hour=False,
                    match_minute=evidence.minutes is not None,
                )
                matches = prefer_one_fresh_candidate(matches)
            if not matches and identity_emails:
                matches = matches_for(
                    charges,
                    include_time_constraints=False,
                    match_hour=False,
                    match_minute=False,
                )
                matches = prefer_one_fresh_candidate(matches)

            # A charge can be discoverable by receipt_email without being
            # attached to the Customer returned by the email lookup. Retry
            # with a bounded fallback only when the cheaper customer-scoped
            # search produced no match; never broaden an already successful
            # match into a second candidate set.
            if not matches and customer_ids:
                charges = (
                    await self._charges_for_day(client, start_timestamp, end_timestamp)
                    if evidence.payment_date is not None
                    else await self._charges_for_lookback(client)
                )
                matches = matches_for(
                    charges,
                    include_time_constraints=False,
                    match_hour=False,
                    match_minute=True,
                )
                matches = prefer_one_fresh_candidate(matches)
                if not matches and identity_emails:
                    matches = matches_for(
                        charges,
                        include_time_constraints=False,
                        match_hour=False,
                        match_minute=False,
                    )
                    matches = prefer_one_fresh_candidate(matches)

            # A narrow day/time Search query can legitimately return an empty
            # set when the receipt clock and Stripe's account clock cross a
            # timezone boundary, when the dashboard record is newer than the
            # Search index, or when the caption date was OCR'd from a stale
            # receipt. Retry once with a bounded amount/lookback query and
            # retain all local evidence constraints before approving anything.
            if (
                not matches
                and evidence.amount_cents is not None
                and (evidence.payment_date is not None or evidence.minutes is not None or evidence.transaction_id)
            ):
                broad_lower_timestamp = int(datetime.now(timezone.utc).timestamp()) - int(
                    timedelta(days=self.lookback_days).total_seconds()
                )
                broad_query = self._charge_search_query(
                    evidence,
                    lower_timestamp=broad_lower_timestamp,
                )
                broad_charges: list[dict[str, Any]] = []
                if broad_query is not None:
                    try:
                        broad_charges = await self._charges_for_search(client, broad_query)
                    except StripeVerificationError as exc:
                        if exc.reason_code == "STRIPE_API_ERROR":
                            broad_charges = await self._charges_for_lookback(client)
                        elif exc.reason_code != "STRIPE_PAGINATION_LIMIT":
                            raise
                if broad_charges:
                    merged_charges = {charge.get("id"): charge for charge in charges if charge.get("id")}
                    merged_charges.update({charge.get("id"): charge for charge in broad_charges if charge.get("id")})
                    charges = list(merged_charges.values())
                    matches = matches_for(
                        charges,
                        include_time_constraints=True,
                        match_hour=bool(self.screenshot_timezone),
                        match_minute=False,
                    )
                    matches = prefer_one_fresh_candidate(matches)
                    if not matches and identity_emails:
                        matches = matches_for(
                            charges,
                            include_time_constraints=False,
                            match_hour=False,
                            match_minute=evidence.minutes is not None,
                        )
                        matches = prefer_one_fresh_candidate(matches)
                    if not matches and identity_emails:
                        matches = matches_for(
                            charges,
                            include_time_constraints=False,
                            match_hour=False,
                            match_minute=False,
                        )
                        matches = prefer_one_fresh_candidate(matches)

            # A screenshot/provider transaction ID is a high-strength lookup
            # hint. Use it after the normal customer search and its bounded
            # fallback so a wrong caption email cannot hide the
            # correct charge. Amount, status, currency, payment method, and
            # available receipt time/date still have to agree; an ID alone is
            # never allowed to bypass charge eligibility checks.
            def transaction_matches_for(
                candidate_charges: list[dict[str, Any]],
                *,
                include_time_constraints: bool,
                match_hour: bool,
            ) -> list[dict[str, Any]]:
                return [
                    charge for charge in candidate_charges
                    if self._transaction_id_matches(charge, evidence)
                    and self._matches(
                        charge,
                        evidence,
                        customer_ids,
                        match_zone,
                        require_identity=False,
                        include_time_constraints=include_time_constraints,
                        match_hour=match_hour,
                    )
                ]

            transaction_matches = transaction_matches_for(
                charges,
                include_time_constraints=True,
                match_hour=bool(self.screenshot_timezone),
            ) if evidence.transaction_id else []
            # A wrong caption may resolve to a real customer with unrelated
            # charges. Broaden only the identifier search to a bounded
            # date/lookback query in that case; never let a customer-scoped
            # result hide a valid exact transaction identifier.
            if not transaction_matches and evidence.transaction_id and customer_ids:
                charges = (
                    await self._charges_for_day(client, start_timestamp, end_timestamp)
                    if evidence.payment_date is not None
                    else await self._charges_for_lookback(client)
                )
                transaction_matches = transaction_matches_for(
                    charges,
                    include_time_constraints=True,
                    match_hour=bool(self.screenshot_timezone),
                )
            if not transaction_matches and evidence.transaction_id:
                # The provider identifier is unique evidence. Relax only the
                # display-time constraints after the strict match fails; the
                # charge's amount, status, currency, and method remain gated.
                transaction_matches = transaction_matches_for(
                    charges,
                    include_time_constraints=False,
                    match_hour=False,
                )
            transaction_id_match = False
            if len(transaction_matches) > 1:
                result = StripeVerificationResult(
                    processing_id,
                    "AMBIGUOUS",
                    "UNCLEAR",
                    "MULTIPLE_TRANSACTION_ID_MATCHES",
                    candidate_count=len(transaction_matches),
                    email_hash=email_hash,
                )
                self.audit_logger.log_verification(processing_id, result, safe_details="ambiguous_transaction_id")
                return result
            if len(transaction_matches) == 1:
                matches = transaction_matches
                transaction_id_match = True

            # A syntactically valid caption can still be stale or mistyped.
            # If it produced no match, recover only from at least two
            # independent OCR constraints and only when exactly one eligible
            # Stripe charge remains. The returned customer_email is then the
            # authoritative identity, not the caption.
            recovered_identity = False
            if not matches and identity_emails and evidence_constraint_count >= 2:
                recovery_matches = [
                    charge for charge in charges
                    if self._matches(
                        charge,
                        evidence,
                        customer_ids,
                        match_zone,
                        require_identity=False,
                        include_time_constraints=True,
                        match_hour=bool(self.screenshot_timezone),
                    )
                ]
                recovery_matches = prefer_one_fresh_candidate(recovery_matches)
                if len(recovery_matches) == 1:
                    matches = recovery_matches
                    recovered_identity = True
                elif len(recovery_matches) > 1:
                    result = StripeVerificationResult(
                        processing_id,
                        "AMBIGUOUS",
                        "UNCLEAR",
                        "MULTIPLE_IDENTITY_RECOVERY_MATCHES",
                        candidate_count=len(recovery_matches),
                        email_hash=email_hash,
                    )
                    self.audit_logger.log_verification(processing_id, result, safe_details="ambiguous_identity_recovery")
                    return result

            if len(matches) == 1:
                matched_transaction = self._transaction_details(matches[0], zone)
                if matched_transaction is not None and not matched_transaction.get("customer_email"):
                    customer_id = matches[0].get("customer")
                    if not identity_emails and isinstance(customer_id, str) and customer_id:
                        matched_transaction["customer_email"] = await self._customer_email(client, customer_id)
                matched_email = matched_transaction.get("customer_email") if matched_transaction else None
                if (
                    isinstance(matched_email, str)
                    and evidence.email
                    and matched_email.casefold() != evidence.email.casefold()
                ):
                    recovered_identity = True
                has_ocr_constraints = evidence_constraint_count > 0
                result = StripeVerificationResult(
                    processing_id,
                    "MATCHED",
                    "VALID",
                    "TRANSACTION_ID_MATCH" if transaction_id_match else "IDENTITY_RECOVERED_FROM_STRIPE" if recovered_identity else "EXACT_SINGLE_MATCH" if has_ocr_constraints else "EMAIL_SINGLE_MATCH",
                    stripe_charge_id=matches[0].get("id"),
                    candidate_count=1,
                    email_hash=email_hash,
                    matched_transaction=matched_transaction,
                )
            elif len(matches) > 1:
                result = StripeVerificationResult(
                    processing_id,
                    "AMBIGUOUS",
                    "UNCLEAR",
                    "MULTIPLE_EXACT_MATCHES",
                    candidate_count=len(matches),
                    email_hash=email_hash,
                )
            else:
                result = StripeVerificationResult(
                    processing_id,
                    "NO_MATCH",
                    "UNCLEAR",
                    "NO_EXACT_MATCH",
                    candidate_count=0,
                    email_hash=email_hash,
                )
        except StripeVerificationError as exc:
            # A bounded search is intentionally never an approval. Report it
            # as unclear so the WhatsApp layer uses the review reaction rather
            # than presenting a pagination ceiling as a fake payment.
            if exc.reason_code == "STRIPE_PAGINATION_LIMIT":
                result = StripeVerificationResult(
                    processing_id,
                    "SEARCH_LIMITED",
                    "UNCLEAR",
                    exc.reason_code,
                    email_hash=email_hash,
                    retryable=False,
                )
            else:
                result = StripeVerificationResult(
                    processing_id,
                    "ERROR",
                    "ERROR",
                    exc.reason_code,
                    email_hash=email_hash,
                    retryable=exc.retryable,
                )
        finally:
            if owned_client:
                await client.aclose()

        self.audit_logger.log_verification(processing_id, result, safe_details="stripe_read_only_match")
        return result

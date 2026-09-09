"""Read-only, test-mode Stripe transaction verification.

The verifier treats OCR and the WhatsApp caption as untrusted evidence. It
only returns VALID after a single Stripe charge matches the normalized email,
integer amount, currency, payment method, and configured local timestamp
criteria. Ambiguous or incomplete evidence is never approved.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from src.logging.audit import AuditLogger


EMAIL_PATTERN = re.compile(
    r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
    r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$"
)


@dataclass(frozen=True)
class PaymentEvidence:
    email: str
    amount_cents: int
    payment_date: date
    minutes: int
    payment_hour: Optional[int] = None
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

    def as_dict(self) -> dict[str, Any]:
        return {
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


class StripeVerificationError(Exception):
    def __init__(self, reason_code: str, retryable: bool = False):
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.retryable = retryable


def normalize_email(value: str) -> str:
    normalized = value.strip().casefold()
    if not EMAIL_PATTERN.fullmatch(normalized):
        raise ValueError("invalid email")
    return normalized


def _email_hash(email: str) -> str:
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
        max_pages: int = 10,
        allowed_payment_method_type: str = "cashapp",
        http_client: Optional[httpx.AsyncClient] = None,
        audit_logger: Optional[AuditLogger] = None,
    ):
        self.secret_key = secret_key
        self.mode = mode
        self.base_url = base_url.rstrip("/")
        self.api_version = api_version
        self.timeout_seconds = timeout_seconds
        self.timezone_name = timezone_name
        self.max_pages = max_pages
        self.allowed_payment_method_type = allowed_payment_method_type.casefold()
        self.http_client = http_client
        self.audit_logger = audit_logger or AuditLogger("stripe_verifier")

    def _validate_configuration(self) -> None:
        if self.mode != "test":
            raise StripeVerificationError("STRIPE_TEST_MODE_REQUIRED")
        if not self.secret_key:
            raise StripeVerificationError("STRIPE_SECRET_KEY_MISSING")
        if not self.secret_key.startswith("sk_test_"):
            raise StripeVerificationError("STRIPE_TEST_SECRET_REQUIRED")
        if self.max_pages < 1 or self.max_pages > 100:
            raise StripeVerificationError("STRIPE_MAX_PAGES_INVALID")

    async def _get(self, client: httpx.AsyncClient, path: str, params: dict[str, Any]) -> dict[str, Any]:
        headers = {"accept": "application/json"}
        if self.api_version:
            headers["Stripe-Version"] = self.api_version

        try:
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
            raise StripeVerificationError(reason, retryable=retryable)

        try:
            body = response.json()
        except ValueError as exc:
            raise StripeVerificationError("STRIPE_INVALID_RESPONSE", retryable=True) from exc
        if not isinstance(body, dict):
            raise StripeVerificationError("STRIPE_INVALID_RESPONSE", retryable=True)
        return body

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

    @staticmethod
    def _charge_email(charge: dict[str, Any]) -> Optional[str]:
        receipt_email = charge.get("receipt_email")
        if isinstance(receipt_email, str) and receipt_email.strip():
            return receipt_email.strip().casefold()
        billing_details = charge.get("billing_details")
        if isinstance(billing_details, dict) and isinstance(billing_details.get("email"), str):
            return billing_details["email"].strip().casefold()
        return None

    def _matches(
        self,
        charge: dict[str, Any],
        evidence: PaymentEvidence,
        customer_ids: set[str],
        zone: ZoneInfo,
    ) -> bool:
        charge_email = self._charge_email(charge)
        customer_id = charge.get("customer")
        email_matches = charge_email == evidence.email or customer_id in customer_ids
        if not email_matches:
            return False

        if charge.get("amount") != evidence.amount_cents:
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

        local_created = _charge_local_datetime(charge, zone)
        if local_created is None:
            return False
        if local_created.date() != evidence.payment_date or local_created.minute != evidence.minutes:
            return False
        if evidence.payment_hour is not None and local_created.hour != evidence.payment_hour:
            return False
        return True

    async def verify(self, evidence: PaymentEvidence, processing_id: str) -> StripeVerificationResult:
        try:
            evidence = replace(
                evidence,
                email=normalize_email(evidence.email),
                currency=evidence.currency.casefold(),
                payment_method_type=evidence.payment_method_type.casefold(),
            )
        except (AttributeError, ValueError):
            result = StripeVerificationResult(processing_id, "ERROR", "ERROR", "INVALID_EVIDENCE")
            self.audit_logger.log_verification(processing_id, result, safe_details="invalid_evidence")
            return result

        if self.allowed_payment_method_type and evidence.payment_method_type != self.allowed_payment_method_type:
            result = StripeVerificationResult(processing_id, "ERROR", "ERROR", "UNSUPPORTED_PAYMENT_METHOD_TYPE")
            self.audit_logger.log_verification(processing_id, result, safe_details="payment_method_policy")
            return result

        email_hash = _email_hash(evidence.email)
        try:
            self._validate_configuration()
            start_timestamp, end_timestamp, zone = _local_day_bounds(evidence.payment_date, self.timezone_name)
        except (StripeVerificationError, TypeError, ValueError) as exc:
            reason_code = exc.reason_code if isinstance(exc, StripeVerificationError) else str(exc)
            result = StripeVerificationResult(processing_id, "ERROR", "ERROR", reason_code, email_hash=email_hash)
            self.audit_logger.log_verification(processing_id, result, safe_details="configuration_error")
            return result

        owned_client = self.http_client is None
        client = self.http_client or httpx.AsyncClient(timeout=self.timeout_seconds)
        try:
            customer_ids = await self._customer_ids(client, evidence.email)
            charges = await self._charges_for_day(client, start_timestamp, end_timestamp)
            matches = [charge for charge in charges if self._matches(charge, evidence, customer_ids, zone)]

            if len(matches) == 1:
                result = StripeVerificationResult(
                    processing_id,
                    "MATCHED",
                    "VALID",
                    "EXACT_SINGLE_MATCH",
                    stripe_charge_id=matches[0].get("id"),
                    candidate_count=1,
                    email_hash=email_hash,
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

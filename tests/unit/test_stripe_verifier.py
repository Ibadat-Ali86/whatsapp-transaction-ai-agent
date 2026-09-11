from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from src.verification.stripe_verifier import (
    PaymentEvidence,
    StripeVerificationError,
    StripeVerifier,
)


def stripe_timestamp(hour: int = 14, minute: int = 31) -> int:
    return int(datetime(2026, 9, 9, hour, minute, tzinfo=timezone.utc).timestamp())


def charge(charge_id: str = "ch_match", **overrides):
    value = {
        "id": charge_id,
        "amount": 2500,
        "currency": "usd",
        "created": stripe_timestamp(),
        "paid": True,
        "status": "succeeded",
        "refunded": False,
        "customer": "cus_customer",
        "receipt_email": None,
        "payment_method_details": {"type": "cashapp"},
    }
    value.update(overrides)
    return value


def evidence(**overrides) -> PaymentEvidence:
    value = {
        "email": "Customer@example.com",
        "amount_cents": 2500,
        "payment_date": datetime(2026, 9, 9, tzinfo=timezone.utc).date(),
        "minutes": 31,
        "payment_hour": 14,
    }
    value.update(overrides)
    return PaymentEvidence(**value)


async def verify_with_responses(responses, evidence_value=None, **verifier_options):
    requests = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return responses(request)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        verifier = StripeVerifier(
            "sk_test_unit_test_key",
            http_client=client,
            timezone_name="UTC",
            **verifier_options,
        )
        result = await verifier.verify(evidence_value or evidence(), "wa-test-stripe")
    return result, requests


@pytest.mark.asyncio
async def test_matches_one_exact_cash_app_charge():
    def responses(request):
        if request.url.path == "/v1/customers":
            assert request.url.params["email"] == "customer@example.com"
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={"data": [charge()], "has_more": False})

    result, requests = await verify_with_responses(responses)

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"
    assert result.stripe_charge_id == "ch_match"
    assert len(requests) == 2
    assert all("sk_test_unit_test_key" not in str(request.headers) for request in requests)


@pytest.mark.asyncio
async def test_email_only_lookup_returns_canonical_stripe_transaction():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        assert request.url.params["customer"] == "cus_customer"
        return httpx.Response(200, json={"data": [charge()], "has_more": False})

    result, _ = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(email="customer@example.com"),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "EMAIL_SINGLE_MATCH"
    assert result.matched_transaction["amount_cents"] == 2500
    assert result.matched_transaction["payment_date"] == "2026-09-09"
    assert result.matched_transaction["minutes"] == 31


@pytest.mark.asyncio
async def test_captionless_lookup_recovers_canonical_customer_from_amount_and_time():
    def responses(request):
        assert request.url.path == "/v1/charges"
        assert request.url.params["created[gte]"]
        return httpx.Response(200, json={
            "data": [charge(customer=None, receipt_email="recovered@example.com")],
            "has_more": False,
        })

    result, requests = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=2500,
            minutes=31,
            payment_hour=14,
        ),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"
    assert result.matched_transaction["customer_email"] == "recovered@example.com"
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_captionless_lookup_fetches_email_from_attached_stripe_customer():
    def responses(request):
        if request.url.path == "/v1/charges":
            return httpx.Response(200, json={
                "data": [charge(customer="cus_recovered", receipt_email=None)],
                "has_more": False,
            })
        assert request.url.path == "/v1/customers/cus_recovered"
        return httpx.Response(200, json={"id": "cus_recovered", "email": "customer@example.com"})

    result, requests = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(email=None, amount_cents=2500, minutes=31, payment_hour=14),
    )

    assert result.verdict == "VALID"
    assert result.matched_transaction["customer_email"] == "customer@example.com"
    assert [request.url.path for request in requests] == ["/v1/charges", "/v1/customers/cus_recovered"]


@pytest.mark.asyncio
async def test_wrong_caption_can_recover_only_one_charge_from_two_ocr_constraints():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [], "has_more": False})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [charge(customer=None, receipt_email="actual@example.com")],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(
            email="wrong@example.com",
            payment_date=datetime(2026, 9, 9, tzinfo=timezone.utc).date(),
        ),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "IDENTITY_RECOVERED_FROM_STRIPE"
    assert result.matched_transaction["customer_email"] == "actual@example.com"


@pytest.mark.asyncio
async def test_captionless_lookup_with_one_constraint_is_unclear_without_network_call():
    result, requests = await verify_with_responses(
        lambda _request: httpx.Response(500),
        evidence_value=PaymentEvidence(email=None, amount_cents=2500),
    )

    assert result.status == "NO_MATCH"
    assert result.verdict == "UNCLEAR"
    assert result.reason_code == "INSUFFICIENT_STRIPE_EVIDENCE"
    assert requests == []


@pytest.mark.asyncio
async def test_falls_back_to_receipt_email_when_charge_has_no_customer_id():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        if request.url.params.get("customer") == "cus_customer":
            return httpx.Response(200, json={"data": [], "has_more": False})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [charge(customer=None, receipt_email="customer@example.com")],
            "has_more": False,
        })

    result, requests = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(email="customer@example.com", amount_cents=2500),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_ambiguous_exact_matches_fail_closed():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        return httpx.Response(200, json={"data": [charge("ch_one"), charge("ch_two")], "has_more": False})

    result, _ = await verify_with_responses(responses)

    assert result.status == "AMBIGUOUS"
    assert result.verdict == "UNCLEAR"
    assert result.reason_code == "MULTIPLE_EXACT_MATCHES"
    assert result.stripe_charge_id is None
    assert result.candidate_count == 2


@pytest.mark.asyncio
async def test_wrong_amount_is_not_approved():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        return httpx.Response(200, json={"data": [charge(amount=2600)], "has_more": False})

    result, _ = await verify_with_responses(responses)

    assert result.status == "NO_MATCH"
    assert result.verdict == "UNCLEAR"
    assert result.stripe_charge_id is None


@pytest.mark.asyncio
async def test_follows_charge_pagination():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        if "starting_after" not in request.url.params:
            return httpx.Response(200, json={"data": [charge("ch_page_one", amount=1000)], "has_more": True})
        assert request.url.params["starting_after"] == "ch_page_one"
        return httpx.Response(200, json={"data": [charge("ch_page_two")], "has_more": False})

    result, requests = await verify_with_responses(responses)

    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_page_two"
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_follows_customer_pagination():
    def responses(request):
        if request.url.path == "/v1/customers":
            if "starting_after" not in request.url.params:
                return httpx.Response(200, json={
                    "data": [{"id": "cus_page_one", "email": "other@example.com"}],
                    "has_more": True,
                })
            assert request.url.params["starting_after"] == "cus_page_one"
            return httpx.Response(200, json={
                "data": [{"id": "cus_customer", "email": "customer@example.com"}],
                "has_more": False,
            })
        return httpx.Response(200, json={"data": [charge()], "has_more": False})

    result, requests = await verify_with_responses(responses)

    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_match"
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_live_secret_is_rejected_in_test_mode_before_network_access():
    called = False

    async def handler(_request):
        nonlocal called
        called = True
        return httpx.Response(500)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        verifier = StripeVerifier("sk_live_not_allowed", http_client=client)
        result = await verifier.verify(evidence(), "wa-live-key")

    assert result.status == "ERROR"
    assert result.reason_code == "STRIPE_TEST_SECRET_REQUIRED"
    assert called is False


def test_restricted_test_secret_is_accepted_by_configuration():
    verifier = StripeVerifier("rk_test_read_only_key")
    verifier._validate_configuration()


def test_restricted_live_secret_is_accepted_by_configuration():
    verifier = StripeVerifier("rk_live_read_only_key", mode="live")
    verifier._validate_configuration()


@pytest.mark.asyncio
async def test_live_mode_uses_restricted_key_for_read_only_lookup():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={
                "data": [{"id": "cus_live", "email": "customer@example.com"}],
                "has_more": False,
            })
        assert request.url.path == "/v1/charges"
        assert request.url.params["customer"] == "cus_live"
        return httpx.Response(200, json={"data": [charge(customer="cus_live")], "has_more": False})

    async with httpx.AsyncClient(transport=httpx.MockTransport(responses)) as client:
        verifier = StripeVerifier(
            "rk_live_read_only_key",
            mode="live",
            http_client=client,
        )
        result = await verifier.verify(
            PaymentEvidence(email="customer@example.com", amount_cents=2500),
            "wa-live-read-only",
        )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"


def test_live_mode_rejects_test_secret_before_network_access():
    verifier = StripeVerifier("rk_test_read_only_key", mode="live")
    with pytest.raises(StripeVerificationError) as error:
        verifier._validate_configuration()
    assert error.value.reason_code == "STRIPE_LIVE_SECRET_REQUIRED"


def test_publishable_live_key_is_rejected_before_network_access():
    verifier = StripeVerifier("pk_live_publishable_key", mode="live")
    with pytest.raises(StripeVerificationError) as error:
        verifier._validate_configuration()
    assert error.value.reason_code == "STRIPE_LIVE_SECRET_REQUIRED"

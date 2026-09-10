from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from src.verification.stripe_verifier import PaymentEvidence, StripeVerifier


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
async def test_live_secret_is_rejected_before_network_access():
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

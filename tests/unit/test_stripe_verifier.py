from __future__ import annotations

import asyncio
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
        "description": "Order 001",
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
        timezone_name = verifier_options.pop("timezone_name", "UTC")
        verifier = StripeVerifier(
            "sk_test_unit_test_key",
            http_client=client,
            timezone_name=timezone_name,
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
        assert request.url.params["customer"] == "cus_customer"
        assert "created[gte]" not in request.url.params
        assert "created[lte]" not in request.url.params
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
    assert result.matched_transaction["description"] == "Order 001"


@pytest.mark.asyncio
async def test_captionless_lookup_recovers_canonical_customer_from_amount_and_time():
    def responses(request):
        assert request.url.path == "/v1/charges/search"
        assert "amount:2500" in request.url.params["query"]
        assert 'currency:"usd"' in request.url.params["query"]
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
async def test_captionless_month_day_receipt_at_midnight_matches_us_central_charge():
    charge_created = int(datetime(2026, 9, 12, 4, 58, tzinfo=timezone.utc).timestamp())

    def responses(request):
        assert request.url.path == "/v1/charges/search"
        assert "amount:500" in request.url.params["query"]
        return httpx.Response(200, json={
            "data": [charge(
                "ch_sep_11_late",
                amount=500,
                created=charge_created,
                customer=None,
                receipt_email="recovered@example.com",
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        timezone_name="America/Chicago",
        screenshot_timezone="America/Chicago",
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=500,
            payment_month=9,
            payment_day=11,
            minutes=58,
            payment_hour=23,
        ),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"
    assert result.stripe_charge_id == "ch_sep_11_late"
    assert result.matched_transaction["payment_date"] == "2026-09-11"
    assert result.matched_transaction["payment_time"] == "23:58"


@pytest.mark.asyncio
async def test_captionless_search_follows_search_cursor_before_matching():
    def responses(request):
        assert request.url.path == "/v1/charges/search"
        if "page" not in request.url.params:
            return httpx.Response(200, json={
                "data": [charge("ch_other_amount", amount=1000)],
                "has_more": True,
                "next_page": "search-page-2",
            })
        assert request.url.params["page"] == "search-page-2"
        return httpx.Response(200, json={
            "data": [charge(customer=None, receipt_email="recovered@example.com")],
            "has_more": False,
        })

    result, requests = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(email=None, amount_cents=2500, minutes=31),
        max_pages=2,
    )

    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_match"
    assert len(requests) == 2


@pytest.mark.asyncio
async def test_captionless_empty_search_falls_back_to_bounded_day_list():
    def responses(request):
        if request.url.path == "/v1/charges/search":
            return httpx.Response(200, json={"data": [], "has_more": False})
        assert request.url.path == "/v1/charges"
        assert "created[gte]" in request.url.params
        assert "created[lte]" in request.url.params
        return httpx.Response(200, json={"data": [charge(customer=None, receipt_email="recovered@example.com")], "has_more": False})

    result, requests = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=2500,
            payment_date=datetime(2026, 9, 9, tzinfo=timezone.utc).date(),
            minutes=31,
            payment_hour=14,
        ),
    )

    assert result.verdict == "VALID"
    assert result.matched_transaction["customer_email"] == "recovered@example.com"
    assert [request.url.path for request in requests] == ["/v1/charges/search", "/v1/charges"]


@pytest.mark.asyncio
async def test_captionless_lookup_fetches_email_from_attached_stripe_customer():
    def responses(request):
        if request.url.path == "/v1/charges/search":
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
    assert [request.url.path for request in requests] == ["/v1/charges/search", "/v1/customers/cus_recovered"]


@pytest.mark.asyncio
async def test_captionless_lookup_handles_receipt_local_time_without_configured_timezone():
    charge_created = int(datetime(2026, 8, 14, 14, 23, tzinfo=timezone.utc).timestamp())

    def responses(request):
        assert request.url.path == "/v1/charges/search"
        return httpx.Response(200, json={
            "data": [charge(
                customer=None,
                receipt_email="recovered@example.com",
                created=charge_created,
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=2500,
            payment_month=8,
            payment_day=14,
            minutes=23,
            payment_hour=9,
        ),
    )

    assert result.verdict == "VALID"
    assert result.matched_transaction["customer_email"] == "recovered@example.com"
    # Stripe output remains in the configured canonical timezone, while the
    # screenshot hour is intentionally not used as a hard filter here.
    assert result.matched_transaction["payment_time"] == "14:23"


@pytest.mark.asyncio
async def test_relative_today_uses_receive_window_after_customer_pagination():
    receive_time = datetime(2026, 9, 9, 15, 0, tzinfo=timezone.utc)

    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        if request.url.path == "/v1/charges" and request.url.params.get("customer") == "cus_customer":
            return httpx.Response(200, json={"data": [charge("ch_recent_page")], "has_more": True})
        assert request.url.path == "/v1/charges/search"
        assert "created>" in request.url.params["query"]
        assert "created<" in request.url.params["query"]
        return httpx.Response(200, json={"data": [charge(receipt_email="customer@example.com")], "has_more": False})

    result, _ = await verify_with_responses(
        responses,
        max_pages=1,
        evidence_value=PaymentEvidence(
            email="customer@example.com",
            amount_cents=2500,
            minutes=31,
            payment_hour=14,
            relative_today=True,
            received_at=receive_time,
        ),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"


@pytest.mark.asyncio
async def test_unique_date_and_customer_name_recovers_when_minute_is_misread():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        if request.url.path == "/v1/charges/search":
            return httpx.Response(200, json={"data": [], "has_more": False})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [charge(
                "ch_name_recovery",
                created=stripe_timestamp(hour=14, minute=12),
                billing_details={"name": "Jenny Waters"},
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(customer_name="jenny waters", minutes=31),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "IDENTITY_RECOVERED_FROM_STRIPE"
    assert result.stripe_charge_id == "ch_name_recovery"


@pytest.mark.asyncio
async def test_captionless_lookup_can_enforce_known_receipt_timezone():
    charge_created = int(datetime(2026, 8, 14, 14, 23, tzinfo=timezone.utc).timestamp())

    def responses(request):
        assert request.url.path == "/v1/charges/search"
        return httpx.Response(200, json={
            "data": [charge(
                customer=None,
                receipt_email="recovered@example.com",
                created=charge_created,
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        screenshot_timezone="America/Chicago",
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=2500,
            payment_month=8,
            payment_day=14,
            minutes=23,
            payment_hour=9,
        ),
    )

    assert result.verdict == "VALID"


@pytest.mark.asyncio
async def test_known_receipt_timezone_offset_falls_back_to_same_day_and_minute():
    # The receipt displays 09:23, but the Stripe-created timestamp is 20:23
    # UTC. The first Central-time search misses it; the safe same-day fallback
    # must recover it by amount/date/minute without trusting the shifted hour.
    charge_created = int(datetime(2026, 9, 9, 20, 23, tzinfo=timezone.utc).timestamp())

    def responses(request):
        if request.url.path == "/v1/charges":
            # Search is intentionally empty first; the verifier must retain
            # its bounded legacy day fallback for accounts where Search is
            # eventually consistent.
            return httpx.Response(200, json={
                "data": [charge(
                    customer=None,
                    receipt_email="recovered@example.com",
                    created=charge_created,
                )],
                "has_more": False,
            })
        assert request.url.path == "/v1/charges/search"
        query = request.url.params["query"]
        if "created>1788963719" in query:
            return httpx.Response(200, json={"data": [], "has_more": False})
        return httpx.Response(200, json={
            "data": [charge(
                customer=None,
                receipt_email="recovered@example.com",
                created=charge_created,
            )],
            "has_more": False,
        })

    result, requests = await verify_with_responses(
        responses,
        screenshot_timezone="America/Chicago",
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=2500,
            payment_date=datetime(2026, 9, 9, tzinfo=timezone.utc).date(),
            minutes=23,
            payment_hour=9,
        ),
    )

    assert result.verdict == "VALID"
    assert result.matched_transaction["customer_email"] == "recovered@example.com"
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_unknown_receipt_timezone_recovers_unique_adjacent_day_match_with_customer_name():
    charge_created = int(datetime(2026, 9, 20, 1, 43, tzinfo=timezone.utc).timestamp())

    def responses(request):
        assert request.url.path == "/v1/charges/search"
        query = request.url.params["query"]
        assert "amount:677" in query
        assert "created>" in query
        assert "created<" in query
        return httpx.Response(200, json={
            "data": [charge(
                "ch_677_timezone_boundary",
                amount=677,
                created=charge_created,
                customer=None,
                receipt_email=None,
                billing_details={"name": "Van Pham"},
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        timezone_name="UTC",
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=677,
            payment_date=datetime(2026, 9, 19, tzinfo=timezone.utc).date(),
            minutes=43,
            payment_hour=23,
            customer_name="van pham",
        ),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "TIMEZONE_BOUNDARY_SINGLE_MATCH"
    assert result.stripe_charge_id == "ch_677_timezone_boundary"


@pytest.mark.asyncio
async def test_unknown_receipt_timezone_keeps_adjacent_day_tie_unclear():
    def responses(request):
        assert request.url.path == "/v1/charges/search"
        return httpx.Response(200, json={
            "data": [
                charge(
                    "ch_677_boundary_one",
                    amount=677,
                    created=int(datetime(2026, 9, 20, 1, 43, tzinfo=timezone.utc).timestamp()),
                    customer=None,
                    receipt_email=None,
                    billing_details={"name": "Van Pham"},
                ),
                charge(
                    "ch_677_boundary_two",
                    amount=677,
                    created=int(datetime(2026, 9, 20, 3, 43, tzinfo=timezone.utc).timestamp()),
                    customer=None,
                    receipt_email=None,
                    billing_details={"name": "Van Pham"},
                ),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        timezone_name="UTC",
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=677,
            payment_date=datetime(2026, 9, 19, tzinfo=timezone.utc).date(),
            minutes=43,
            payment_hour=23,
            customer_name="Van Pham",
        ),
    )

    assert result.status == "AMBIGUOUS"
    assert result.verdict == "UNCLEAR"
    assert result.reason_code == "MULTIPLE_EXACT_MATCHES"
    assert result.candidate_count == 2


@pytest.mark.asyncio
async def test_wrong_caption_can_recover_only_one_charge_from_two_ocr_constraints():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [], "has_more": False})
        assert request.url.path == "/v1/charges/search"
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
async def test_ocr_email_candidate_recovers_a_mistyped_caption_email():
    def responses(request):
        if request.url.path == "/v1/customers":
            email = request.url.params["email"]
            if email == "actual@example.com":
                return httpx.Response(200, json={"data": [{"id": "cus_actual", "email": email}], "has_more": False})
            return httpx.Response(200, json={"data": [], "has_more": False})
        assert request.url.path == "/v1/charges"
        assert request.url.params["customer"] == "cus_actual"
        return httpx.Response(200, json={
            "data": [charge(customer="cus_actual", receipt_email="actual@example.com")],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(
            email="mistyped@example.com",
            email_candidates=("actual@example.com",),
        ),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "IDENTITY_RECOVERED_FROM_STRIPE"
    assert result.matched_transaction["customer_email"] == "actual@example.com"


@pytest.mark.asyncio
async def test_transaction_id_recovers_charge_when_caption_email_is_wrong():
    def responses(request):
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [charge(
                "ch_transaction_id",
                customer=None,
                receipt_email="actual@example.com",
                metadata={"payment_identifier": "FQ2JKTVZ0"},
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(email="wrong@example.com", transaction_id="FQ2JKTVZ0"),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "TRANSACTION_ID_MATCH"
    assert result.stripe_charge_id == "ch_transaction_id"
    assert result.matched_transaction["customer_email"] == "actual@example.com"


@pytest.mark.asyncio
async def test_cash_app_payment_identifier_selects_one_charge_from_nested_stripe_details():
    def responses(request):
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [charge(
                "ch_cashapp_identifier",
                customer=None,
                receipt_email="actual@example.com",
                payment_method_details={
                    "type": "cashapp",
                    "cashapp": {"transaction_id": "R6J4AXTXR"},
                },
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(
            email="wrong@example.com",
            transaction_id="R6J4AXTXR",
        ),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "TRANSACTION_ID_MATCH"
    assert result.stripe_charge_id == "ch_cashapp_identifier"
    assert result.matched_transaction["payment_identifier"] == "R6J4AXTXR"


@pytest.mark.asyncio
async def test_identifier_first_scan_reaches_later_charge_without_search_cursor():
    def responses(request):
        assert request.url.path == "/v1/charges"
        if "starting_after" not in request.url.params:
            return httpx.Response(200, json={
                "data": [charge("ch_recent_unrelated")],
                "has_more": True,
            })
        assert request.url.params["starting_after"] == "ch_recent_unrelated"
        return httpx.Response(200, json={
            "data": [charge(
                "ch_exact_later",
                customer=None,
                receipt_email="actual@example.com",
                metadata={"payment_identifier": "LATER123"},
            )],
            "has_more": False,
        })

    result, requests = await verify_with_responses(
        responses,
        evidence_value=evidence(email="wrong@example.com", transaction_id="LATER123"),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "TRANSACTION_ID_MATCH"
    assert result.stripe_charge_id == "ch_exact_later"
    assert [request.url.path for request in requests] == ["/v1/charges", "/v1/charges"]


@pytest.mark.asyncio
async def test_transaction_id_recovery_checks_bounded_list_when_search_candidates_omit_charge():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [], "has_more": False})
        if request.url.path == "/v1/charges/search":
            return httpx.Response(200, json={
                "data": [charge("ch_unrelated", customer=None)],
                "has_more": False,
            })
        assert request.url.path == "/v1/charges"
        assert "created[gte]" in request.url.params
        return httpx.Response(200, json={
            "data": [charge(
                "ch_recovered_identifier",
                customer=None,
                receipt_email="actual@example.com",
                payment_method_details={
                    "type": "cashapp",
                    "cashapp": {"transaction_id": "R6J4AXTXR"},
                },
            )],
            "has_more": False,
        })

    result, requests = await verify_with_responses(
        responses,
        evidence_value=evidence(
            email=None,
            transaction_id="R6J4AXTXR",
        ),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "TRANSACTION_ID_MATCH"
    assert result.stripe_charge_id == "ch_recovered_identifier"
    assert any(request.url.path == "/v1/charges" for request in requests)


@pytest.mark.asyncio
async def test_pagination_limit_falls_back_to_bounded_list_for_provider_identifier():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [], "has_more": False})
        if request.url.path == "/v1/charges/search":
            return httpx.Response(200, json={
                "data": [charge("ch_search_page")],
                "has_more": True,
                "next_page": "search-page-2",
            })
        assert request.url.path == "/v1/charges"
        assert "created[gte]" in request.url.params
        return httpx.Response(200, json={
            "data": [charge(
                "ch_pagination_recovered",
                customer=None,
                receipt_email="actual@example.com",
                payment_method_details={
                    "type": "cashapp",
                    "cashapp": {"transaction_id": "C6SZZXTQ0"},
                },
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        max_pages=1,
        evidence_value=evidence(
            email=None,
            transaction_id="C6SZZXTQ0",
        ),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "TRANSACTION_ID_MATCH"
    assert result.stripe_charge_id == "ch_pagination_recovered"


@pytest.mark.asyncio
async def test_transaction_id_disambiguates_same_amount_and_time_charges():
    def responses(request):
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [
                charge("ch_first", customer=None, receipt_email="first@example.com", metadata={"transaction_id": "FIRST123"}),
                charge("ch_second", customer=None, receipt_email="second@example.com", metadata={"transaction_id": "SECOND123"}),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(
            email=None,
            transaction_id="SECOND123",
            amount_cents=2500,
            payment_date=datetime(2026, 9, 9, tzinfo=timezone.utc).date(),
            minutes=31,
        ),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "TRANSACTION_ID_MATCH"
    assert result.stripe_charge_id == "ch_second"
    assert result.matched_transaction["customer_email"] == "second@example.com"


@pytest.mark.asyncio
async def test_description_disambiguates_same_email_amount_and_time_charges():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [
                charge("ch_order_001", description="Order 001"),
                charge("ch_order_002", description="Order 002"),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(description="  Order   002 "),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"
    assert result.stripe_charge_id == "ch_order_002"
    assert result.matched_transaction["description"] == "Order 002"


@pytest.mark.asyncio
async def test_captionless_amount_and_description_can_recover_one_charge():
    def responses(request):
        assert request.url.path == "/v1/charges/search"
        return httpx.Response(200, json={
            "data": [charge(
                customer=None,
                receipt_email="recovered@example.com",
                description="Order 002",
            )],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=2500,
            description="Order 002",
        ),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"
    assert result.matched_transaction["customer_email"] == "recovered@example.com"


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
        return httpx.Response(200, json={
            "data": [
                charge("ch_one", description="Order 001"),
                charge("ch_two", description="Order 002"),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(responses)

    assert result.status == "AMBIGUOUS"
    assert result.verdict == "UNCLEAR"
    assert result.reason_code == "MULTIPLE_EXACT_MATCHES"
    assert result.stripe_charge_id is None
    assert result.candidate_count == 2
    assert [candidate["stripe_charge_id"] for candidate in result.candidate_transactions] == [
        "ch_one",
        "ch_two",
    ]
    assert result.candidate_transactions[0]["description"] == "Order 001"
    assert result.candidate_transactions[0]["status"] == "Completed"


@pytest.mark.asyncio
async def test_ambiguous_candidates_are_reported_newest_first_without_approval():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        return httpx.Response(200, json={
            "data": [
                charge(
                    "ch_older",
                    created=int(datetime(2026, 9, 9, 10, 31, tzinfo=timezone.utc).timestamp()),
                    description="Older payment",
                    receipt_email="customer@example.com",
                ),
                charge(
                    "ch_newer",
                    created=int(datetime(2026, 9, 9, 18, 31, tzinfo=timezone.utc).timestamp()),
                    description="Recent payment",
                    receipt_email="customer@example.com",
                ),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(responses)

    assert result.verdict == "UNCLEAR"
    assert result.reason_code == "MULTIPLE_EXACT_MATCHES"
    assert [candidate["stripe_charge_id"] for candidate in result.candidate_transactions] == [
        "ch_newer",
        "ch_older",
    ]
    assert result.candidate_transactions[0]["description"] == "Recent payment"
    assert result.stripe_charge_id is None


@pytest.mark.asyncio
async def test_customer_name_disambiguates_same_email_amount_and_time_safely():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [
                charge("ch_jenny", billing_details={"name": "Jenny Waters"}),
                charge("ch_other", billing_details={"name": "Other Customer"}),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(customer_name="jenny waters"),
    )

    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_jenny"
    assert result.matched_transaction["customer_name"] == "Jenny Waters"


@pytest.mark.asyncio
async def test_customer_name_disambiguation_ignores_ocr_edge_punctuation():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [
                charge("ch_rachael", billing_details={"name": "Rachael Matthews"}),
                charge("ch_other", billing_details={"name": "Other Customer"}),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(customer_name="Rachael Matthews."),
    )

    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_rachael"


@pytest.mark.asyncio
async def test_date_and_customer_name_tie_stays_review_required():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        if request.url.path == "/v1/charges/search":
            return httpx.Response(200, json={"data": [], "has_more": False})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [
                charge("ch_name_one", created=stripe_timestamp(hour=10, minute=12), billing_details={"name": "Jenny Waters"}),
                charge("ch_name_two", created=stripe_timestamp(hour=16, minute=12), billing_details={"name": "Jenny Waters"}),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(customer_name="Jenny Waters", minutes=31),
    )

    assert result.verdict == "UNCLEAR"
    assert result.reason_code == "MULTIPLE_DATE_NAME_MATCHES"
    assert result.candidate_count == 2


@pytest.mark.asyncio
async def test_one_unclaimed_charge_resolves_multiple_matches_without_guessing():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={
            "data": [
                charge("ch_already_claimed"),
                charge("ch_fresh"),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(excluded_stripe_charge_ids=("ch_already_claimed",)),
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"
    assert result.stripe_charge_id == "ch_fresh"


@pytest.mark.asyncio
async def test_bounded_broad_amount_search_recovers_charge_after_narrow_search_empty():
    search_calls = 0

    def responses(request):
        nonlocal search_calls
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        if request.url.path == "/v1/charges" and request.url.params.get("customer") == "cus_customer":
            return httpx.Response(200, json={"data": [charge("ch_page_one")], "has_more": True})
        if request.url.path == "/v1/charges" and "created[gte]" in request.url.params:
            return httpx.Response(200, json={"data": [], "has_more": False})
        if request.url.path == "/v1/charges/search":
            search_calls += 1
            if search_calls == 1:
                return httpx.Response(200, json={"data": [], "has_more": False})
            return httpx.Response(200, json={
                "data": [charge("ch_recovered", customer=None, receipt_email="customer@example.com")],
                "has_more": False,
            })
        raise AssertionError(f"unexpected Stripe request: {request.url}")

    result, _ = await verify_with_responses(
        responses,
        max_pages=1,
        evidence_value=evidence(),
    )

    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_recovered"
    assert search_calls == 2


@pytest.mark.asyncio
async def test_email_and_amount_use_receipt_minute_to_disambiguate_customer_charges():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.params["customer"] == "cus_customer"
        return httpx.Response(200, json={
            "data": [
                charge("ch_wrong_minute", created=stripe_timestamp(minute=12)),
                charge("ch_right_minute", created=stripe_timestamp(minute=31)),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(minutes=31),
    )

    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_right_minute"


@pytest.mark.asyncio
async def test_customer_matching_uses_receipt_date_and_hour_before_broad_fallback():
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        assert request.url.params["customer"] == "cus_customer"
        return httpx.Response(200, json={
            "data": [
                # Same customer, amount, and minute, but a different receipt
                # hour. This used to remain ambiguous because the
                # customer-scoped path ignored the receipt date/hour.
                charge("ch_wrong_hour", created=stripe_timestamp(hour=15, minute=31)),
                charge("ch_right_receipt", created=stripe_timestamp(hour=14, minute=31)),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        screenshot_timezone="UTC",
        evidence_value=evidence(payment_hour=14, minutes=31),
    )

    assert result.status == "MATCHED"
    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_right_receipt"


@pytest.mark.asyncio
async def test_receipt_date_never_falls_back_to_stale_customer_amount_matches():
    """An old same-email/amount charge must not become a false candidate.

    This reproduces the production failure where a receipt saying "Today"
    lost its resolved date and the verifier later ignored the date entirely.
    The safe result is no exact match, not approval and not an ambiguous list
    of stale historical payments.
    """
    def responses(request):
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path in {"/v1/charges", "/v1/charges/search"}
        return httpx.Response(200, json={
            "data": [
                charge("ch_old_one", created=stripe_timestamp(hour=14, minute=31)),
                charge("ch_old_two", created=stripe_timestamp(hour=15, minute=31)),
            ],
            "has_more": False,
        })

    result, _ = await verify_with_responses(
        responses,
        evidence_value=evidence(
            payment_date=datetime(2026, 9, 21, tzinfo=timezone.utc).date(),
            payment_hour=2,
            minutes=53,
        ),
    )

    assert result.status == "NO_MATCH"
    assert result.verdict == "UNCLEAR"
    assert result.reason_code == "NO_EXACT_MATCH"
    assert result.candidate_count == 0
    assert result.stripe_charge_id is None


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
        assert request.url.params["customer"] == "cus_customer"
        if "starting_after" not in request.url.params:
            return httpx.Response(200, json={"data": [charge("ch_page_one", amount=1000)], "has_more": True})
        assert request.url.params["starting_after"] == "ch_page_one"
        return httpx.Response(200, json={"data": [charge("ch_page_two")], "has_more": False})

    result, requests = await verify_with_responses(responses)

    assert result.verdict == "VALID"
    assert result.stripe_charge_id == "ch_page_two"
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_page_limit_is_unclear_instead_of_a_false_invalid_error():
    def responses(request):
        if request.url.path == "/v1/charges/search":
            return httpx.Response(200, json={"data": [charge()], "has_more": True, "next_page": "next-page"})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={"data": [charge("ch_recovery_page")], "has_more": True})

    result, requests = await verify_with_responses(
        responses,
        evidence_value=PaymentEvidence(
            email=None,
            amount_cents=2500,
            payment_date=datetime(2026, 9, 9, tzinfo=timezone.utc).date(),
            minutes=31,
        ),
        max_pages=1,
        recovery_max_pages=2,
    )

    assert result.status == "SEARCH_LIMITED"
    assert result.verdict == "UNCLEAR"
    assert result.reason_code == "STRIPE_PAGINATION_LIMIT"
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_retries_transient_stripe_rate_limit_then_matches():
    charge_attempts = 0

    def responses(request):
        nonlocal charge_attempts
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        charge_attempts += 1
        if charge_attempts == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": {"type": "rate_limit_error"}})
        return httpx.Response(200, json={"data": [charge()], "has_more": False})

    result, requests = await verify_with_responses(
        responses,
        requests_per_second=0,
        retry_attempts=2,
        backoff_base_seconds=0,
        backoff_max_seconds=0,
    )

    assert result.verdict == "VALID"
    assert result.reason_code == "EXACT_SINGLE_MATCH"
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_reuses_short_lived_cache_across_verifications():
    requests = []

    async def handler(request):
        requests.append(request)
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"data": [{"id": "cus_customer", "email": "customer@example.com"}]})
        assert request.url.path == "/v1/charges"
        return httpx.Response(200, json={"data": [charge()], "has_more": False})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        verifier = StripeVerifier(
            "sk_test_unit_test_key",
            http_client=client,
            timezone_name="UTC",
            requests_per_second=0,
        )
        first = await verifier.verify(evidence(), "wa-cache-first")
        second = await verifier.verify(evidence(), "wa-cache-second")

    assert first.verdict == "VALID"
    assert second.verdict == "VALID"
    assert len(requests) == 2


@pytest.mark.asyncio
async def test_shared_runtime_limits_concurrent_stripe_requests():
    active = 0
    maximum_active = 0

    async def handler(_request):
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return httpx.Response(200, json={"data": [], "has_more": False})

    from src.verification.stripe_verifier import StripeVerificationRuntime

    runtime = StripeVerificationRuntime(requests_per_second=0, max_concurrent_requests=1)
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        verifier = StripeVerifier(
            "sk_test_unit_test_key",
            http_client=client,
            runtime=runtime,
            requests_per_second=0,
        )
        await asyncio.gather(
            verifier._get(client, "/v1/charges", {"query": "one"}),
            verifier._get(client, "/v1/charges", {"query": "two"}),
        )

    assert maximum_active == 1


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

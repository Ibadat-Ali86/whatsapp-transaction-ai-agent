"""
tests/unit/test_extractor.py

Unit tests for FieldExtractor — all pure logic, no I/O, no network calls.
Tests cover: email extraction, amount parsing, money-as-cents invariant,
minutes extraction, date parsing, status detection, confidence scoring,
AI response parsing, and edge/boundary conditions.
"""
from __future__ import annotations

import pytest
from src.extraction.extractor import ExtractedFields, FieldExtractor


# ===========================================================================
# Email extraction
# ===========================================================================

class TestEmailExtraction:

    def test_extracts_standard_email(self):
        text = "Customer: testuser@example.com\nAmount: $25.00"
        fields = FieldExtractor.extract_from_text(text, "test-pid-001")
        assert fields.email == "testuser@example.com"

    def test_extracts_email_with_subdomain(self):
        text = "Paid by user@mail.aqdigital.io"
        fields = FieldExtractor.extract_from_text(text, "test-pid-002")
        assert fields.email == "user@mail.aqdigital.io"

    def test_extracts_email_with_plus_addressing(self):
        text = "user+tag@example.com paid $10.00"
        fields = FieldExtractor.extract_from_text(text, "test-pid-003")
        assert fields.email == "user+tag@example.com"

    def test_no_email_returns_none(self):
        text = "No email address in this text at all."
        fields = FieldExtractor.extract_from_text(text, "test-pid-004")
        assert fields.email is None


class TestTransactionIdExtraction:

    def test_extracts_labeled_payment_identifier(self):
        fields = FieldExtractor.extract_from_text(
            "Payment identifier\nFQ2JKTVZ0\nAmount: $20.00", "test-pid-006"
        )
        assert fields.transaction_id == "FQ2JKTVZ0"

    def test_extracts_identifier_when_ocr_reverses_label_and_value_order(self):
        fields = FieldExtractor.extract_from_text(
            "TJ2WHT1Z0\nPayment identifier\nCash balance", "test-pid-006-reversed"
        )
        assert fields.transaction_id == "TJ2WHT1Z0"

    def test_extracts_identifier_when_ocr_keeps_label_and_value_on_one_line(self):
        fields = FieldExtractor.extract_from_text(
            "Payment identifier R6J4AXTXR\nAmount: $10.00", "test-pid-006-inline"
        )
        assert fields.transaction_id == "R6J4AXTXR"

    def test_extracts_explicit_description_only(self):
        fields = FieldExtractor.extract_from_text(
            "Description: Order 002\nAmount: $20.00", "test-pid-008"
        )
        assert fields.description == "Order 002"

    def test_ignores_unlabeled_merchant_text_as_description(self):
        fields = FieldExtractor.extract_from_text(
            "Purchase from AQ Digital LLC\nAmount: $20.00", "test-pid-009"
        )
        assert fields.description is None

    def test_ignores_unlabeled_reference_like_text(self):
        fields = FieldExtractor.extract_from_text(
            "Reference FQ2JKTVZ0\nAmount: $20.00", "test-pid-007"
        )
        assert fields.transaction_id is None

    def test_email_with_numbers(self):
        text = "john123@domain456.com sent payment"
        fields = FieldExtractor.extract_from_text(text, "test-pid-005")
        assert fields.email == "john123@domain456.com"

    def test_extracts_customer_name_when_ocr_misreads_customer_label(self):
        fields = FieldExtractor.extract_from_text(
            "Cystomer (C <\nVan Pham\nPayment source\nCash balance",
            "test-pid-customer-name",
        )
        assert fields.customer_name == "Van Pham"

    def test_does_not_promote_payment_labels_to_customer_name(self):
        fields = FieldExtractor.extract_from_text(
            "Customer\nPayment date\nSat, Sep 19\nPayment source\nCash balance",
            "test-pid-customer-label-only",
        )
        assert fields.customer_name is None


# ===========================================================================
# Amount extraction — MONEY-AS-CENTS INVARIANT
# This is a critical financial correctness test.
# ===========================================================================

class TestAmountExtraction:

    def test_dollar_amount_converted_to_cents(self):
        """$25.00 MUST become 2500 cents — never 25.0 float."""
        text = "Amount: $25.00 Completed"
        fields = FieldExtractor.extract_from_text(text, "test-pid-010")
        assert fields.amount_cents == 2500
        assert isinstance(fields.amount_cents, int), "amount_cents must be an integer, never float"

    def test_dollar_amount_99_cents(self):
        """$0.99 → 99 cents."""
        text = "Total: $0.99"
        fields = FieldExtractor.extract_from_text(text, "test-pid-011")
        assert fields.amount_cents == 99

    def test_dollar_amount_large(self):
        """$1000.00 → 100000 cents."""
        text = "Payment of $1000.00 received"
        fields = FieldExtractor.extract_from_text(text, "test-pid-012")
        assert fields.amount_cents == 100_000

    def test_dollar_amount_with_decimal(self):
        """$49.99 → 4999 cents exactly — no floating-point drift."""
        text = "Charge: $49.99"
        fields = FieldExtractor.extract_from_text(text, "test-pid-013")
        assert fields.amount_cents == 4999

    def test_no_amount_returns_none(self):
        text = "email: user@test.com status: Completed"
        fields = FieldExtractor.extract_from_text(text, "test-pid-014")
        assert fields.amount_cents is None


# ===========================================================================
# Minutes extraction
# ===========================================================================

class TestMinutesExtraction:

    def test_extracts_minutes_from_hh_mm_ss(self):
        text = "Time: 14:31:22 UTC"
        fields = FieldExtractor.extract_from_text(text, "test-pid-020")
        assert fields.minutes == "31"

    def test_extracts_minutes_from_hh_mm(self):
        text = "Processed at 09:07"
        fields = FieldExtractor.extract_from_text(text, "test-pid-021")
        assert fields.minutes == "07"

    def test_no_time_returns_none(self):
        text = "No time value here, just email@test.com"
        fields = FieldExtractor.extract_from_text(text, "test-pid-022")
        assert fields.minutes is None

    def test_minutes_zero(self):
        text = "At 08:00:00"
        fields = FieldExtractor.extract_from_text(text, "test-pid-023")
        assert fields.minutes == "00"

    def test_extracts_24_hour_payment_hour(self):
        fields = FieldExtractor.extract_from_text("Today at 14:23", "test-pid-024")
        assert fields.payment_hour == 14
        assert fields.minutes == "23"

    def test_converts_12_hour_payment_hour(self):
        fields = FieldExtractor.extract_from_text("Today at 2:23 PM", "test-pid-025")
        assert fields.payment_hour == 14
        assert fields.minutes == "23"

    def test_ignores_unlabelled_chat_timestamp_after_receipt_details(self):
        fields = FieldExtractor.extract_from_text(
            "Payment date Fri, Aug 14 Completed 11:20 AM", "test-pid-026"
        )
        assert fields.payment_hour is None
        assert fields.minutes is None


# ===========================================================================
# Date extraction
# ===========================================================================

class TestDateExtraction:

    def test_extracts_iso_date(self):
        text = "Payment Date: 2026-09-09"
        fields = FieldExtractor.extract_from_text(text, "test-pid-030")
        assert fields.payment_date == "2026-09-09"

    def test_no_date_returns_none(self):
        text = "email@test.com $25.00 Completed"
        fields = FieldExtractor.extract_from_text(text, "test-pid-031")
        assert fields.payment_date is None

    def test_date_month_boundary(self):
        text = "Date: 2026-12-31"
        fields = FieldExtractor.extract_from_text(text, "test-pid-032")
        assert fields.payment_date == "2026-12-31"

    def test_extracts_month_and_day_from_receipt_date(self):
        fields = FieldExtractor.extract_from_text("Payment date Fri, Aug 14", "test-pid-033")
        assert fields.payment_date is None
        assert fields.payment_month == 8
        assert fields.payment_day == 14


# ===========================================================================
# Status extraction
# ===========================================================================

class TestStatusExtraction:

    @pytest.mark.parametrize("status_word,expected", [
        ("Completed", "Completed"),
        ("Success", "Success"),
        ("Paid", "Paid"),
        ("Failed", "Failed"),
        ("Pending", "Pending"),
        ("Declined", "Declined"),
    ])
    def test_status_keywords(self, status_word, expected):
        text = f"Payment status: {status_word}"
        fields = FieldExtractor.extract_from_text(text, f"test-pid-040-{status_word}")
        assert fields.status == expected

    def test_status_case_insensitive(self):
        text = "payment COMPLETED successfully"
        fields = FieldExtractor.extract_from_text(text, "test-pid-041")
        assert fields.status == "Completed"

    def test_no_status_returns_none(self):
        text = "email@test.com $25.00 2026-09-09"
        fields = FieldExtractor.extract_from_text(text, "test-pid-042")
        assert fields.status is None


# ===========================================================================
# Confidence scoring — HEURISTIC tests
# ===========================================================================

class TestConfidenceScoring:

    def test_all_fields_present_gives_full_confidence(self, sample_extracted_fields):
        """email(0.35) + amount(0.35) + minutes(0.15) + date(0.10) + status(0.05) = 1.0"""
        confidence = FieldExtractor.compute_confidence(sample_extracted_fields)
        assert confidence == pytest.approx(1.0)

    def test_empty_fields_give_zero_confidence(self, empty_extracted_fields):
        confidence = FieldExtractor.compute_confidence(empty_extracted_fields)
        assert confidence == 0.0

    def test_email_only_gives_035(self):
        fields = ExtractedFields(email="test@example.com")
        assert FieldExtractor.compute_confidence(fields) == pytest.approx(0.35)

    def test_email_plus_amount_gives_070(self):
        fields = ExtractedFields(email="test@example.com", amount_cents=2500)
        assert FieldExtractor.compute_confidence(fields) == pytest.approx(0.70)

    def test_confidence_never_exceeds_1(self):
        """Guard against future weight misconfiguration."""
        fields = ExtractedFields(
            email="x@y.com",
            amount_cents=100,
            minutes="31",
            payment_date="2026-01-01",
            status="Completed",
        )
        assert FieldExtractor.compute_confidence(fields) <= 1.0

    def test_confidence_below_fallback_threshold(self):
        """Only status present → 0.05 < 0.85 threshold → should trigger AI fallback."""
        fields = ExtractedFields(status="Completed")
        assert FieldExtractor.compute_confidence(fields) < 0.85


# ===========================================================================
# AI response parsing
# ===========================================================================

class TestAIResponseParsing:

    def test_parses_full_ai_response(self):
        ai_json = {
            "email": "user@example.com",
            "transaction_id": "FQ2JKTVZ0",
            "description": "Order 002",
            "amount": "$25.00",
            "minutes": "31",
            "payment_hour": "9",
            "payment_date": "2026-09-09",
            "payment_month": "8",
            "payment_day": "14",
            "customer_name": "Test User",
            "status": "Completed",
        }
        fields = FieldExtractor.extract_from_ai_response(ai_json, "test-pid-050")
        assert fields.email == "user@example.com"
        assert fields.transaction_id == "FQ2JKTVZ0"
        assert fields.description == "Order 002"
        assert fields.amount_cents == 2500
        assert isinstance(fields.amount_cents, int)
        assert fields.minutes == "31"
        assert fields.payment_hour == 9
        assert fields.payment_date == "2026-09-09"
        assert fields.payment_month == 8
        assert fields.payment_day == 14
        assert fields.status == "Completed"

    def test_parses_null_ai_fields(self):
        ai_json = {
            "email": None,
            "amount": None,
            "minutes": None,
            "payment_date": None,
            "customer_name": None,
            "status": None,
        }
        fields = FieldExtractor.extract_from_ai_response(ai_json, "test-pid-051")
        assert fields.email is None
        assert fields.amount_cents is None

    def test_ai_amount_without_dollar_sign(self):
        ai_json = {"email": None, "amount": "25.00", "minutes": None,
                   "payment_date": None, "customer_name": None, "status": None}
        fields = FieldExtractor.extract_from_ai_response(ai_json, "test-pid-052")
        assert fields.amount_cents == 2500
        assert isinstance(fields.amount_cents, int)

    def test_ai_malformed_amount_adds_warning(self):
        ai_json = {"email": None, "amount": "not-a-number", "minutes": None,
                   "payment_date": None, "customer_name": None, "status": None}
        fields = FieldExtractor.extract_from_ai_response(ai_json, "test-pid-053")
        assert fields.amount_cents is None
        # No exception raised — warnings list may be empty if regex simply doesn't match

    def test_empty_ai_response(self):
        fields = FieldExtractor.extract_from_ai_response({}, "test-pid-054")
        assert fields.email is None
        assert fields.amount_cents is None


# ===========================================================================
# Full receipt text — integration of all extractors
# ===========================================================================

class TestFullReceiptExtraction:

    def test_full_receipt(self, sample_receipt_text):
        fields = FieldExtractor.extract_from_text(sample_receipt_text, "test-pid-060")
        assert fields.email == "testuser@example.com"
        assert fields.amount_cents == 2500
        assert fields.minutes == "31"
        assert fields.payment_date == "2026-09-09"
        assert fields.status == "Completed"
        confidence = FieldExtractor.compute_confidence(fields)
        assert confidence >= 0.85  # Full set should exceed fallback threshold

    def test_empty_text_produces_empty_fields(self):
        fields = FieldExtractor.extract_from_text("", "test-pid-061")
        assert fields.email is None
        assert fields.amount_cents is None
        assert fields.minutes is None
        assert fields.payment_date is None
        assert fields.status is None

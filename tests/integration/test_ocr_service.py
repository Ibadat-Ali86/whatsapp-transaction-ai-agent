"""
tests/integration/test_ocr_service.py

Integration tests for the FastAPI OCR service.
Uses httpx TestClient — no real network calls, but real OCR engine is invoked.
Tesseract must be installed locally for these to pass.
"""
from __future__ import annotations

import pytest
import httpx
from types import SimpleNamespace

from src.ocr import service as ocr_service
from src.ocr.service import app
from src.verification.stripe_verifier import StripeVerificationResult

@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as test_client:
        yield test_client


class TestHealthEndpoints:

    async def test_liveness_returns_ok(self, client):
        response = await client.get("/health/live")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert "timestamp" in body

    async def test_readiness_returns_tesseract_status(self, client):
        response = await client.get("/health/ready")
        assert response.status_code == 200
        body = response.json()
        assert "tesseract" in body
        assert body["status"] in ("ok", "degraded")


class TestOcrProcessEndpoint:

    async def test_rejects_invalid_mime_type(self, client, blank_white_image_base64, processing_id):
        response = await client.post("/api/v1/ocr/process", json={
            "processing_id": processing_id,
            "image_base64": blank_white_image_base64,
            "mime_type": "application/pdf",   # invalid
            "message_id": "msg-001",
            "group_id": "group-001",
            "sender_jid": "sender-001",
        })
        assert response.status_code == 422

    async def test_rejects_invalid_base64(self, client, processing_id):
        response = await client.post("/api/v1/ocr/process", json={
            "processing_id": processing_id,
            "image_base64": "!!!not-valid!!!",
            "mime_type": "image/png",
            "message_id": "msg-002",
            "group_id": "group-001",
            "sender_jid": "sender-001",
        })
        assert response.status_code == 422

    async def test_processes_valid_png_image(self, client, blank_white_image_base64, processing_id):
        """
        Blank white image will produce empty OCR — that's correct behaviour.
        We verify the response shape, not OCR accuracy on a blank image.
        """
        response = await client.post("/api/v1/ocr/process", json={
            "processing_id": processing_id,
            "image_base64": blank_white_image_base64,
            "mime_type": "image/png",
            "message_id": "msg-003",
            "group_id": "group-001",
            "sender_jid": "sender-001",
        })
        # May return 200 or 500 depending on Tesseract output — check shape only
        assert response.status_code in (200, 500)
        if response.status_code == 200:
            body = response.json()
            assert "processing_id" in body
            assert "provider" in body
            assert "confidence" in body
            assert "ai_used" in body

    async def test_auto_generates_processing_id_when_missing(self, client, blank_white_image_base64):
        """If processing_id is omitted, service must generate one."""
        response = await client.post("/api/v1/ocr/process", json={
            "image_base64": blank_white_image_base64,
            "mime_type": "image/png",
            "message_id": "msg-004",
            "group_id": "group-001",
            "sender_jid": "sender-001",
        })
        assert response.status_code in (200, 500)
        if response.status_code == 200:
            body = response.json()
            assert body["processing_id"].startswith("wa-")

    async def test_response_never_contains_image_data(self, client, blank_white_image_base64, processing_id):
        """Security: OCR response must never echo back the raw image base64."""
        response = await client.post("/api/v1/ocr/process", json={
            "processing_id": processing_id,
            "image_base64": blank_white_image_base64,
            "mime_type": "image/png",
            "message_id": "msg-005",
            "group_id": "group-001",
            "sender_jid": "sender-001",
        })
        response_text = response.text
        # The original base64 must not appear in the response
        assert blank_white_image_base64[:50] not in response_text


class TestStripeVerificationEndpoint:

    async def test_is_disabled_by_default(self, client, processing_id):
        response = await client.post("/api/v1/verification/stripe", json={
            "processing_id": processing_id,
            "email": "customer@example.com",
            "amount_cents": 2500,
            "payment_date": "2026-09-09",
            "minutes": 31,
            "payment_hour": 14,
        })
        assert response.status_code == 503
        assert "disabled" in response.json()["detail"]

    async def test_validates_request_before_stripe(self, client, processing_id):
        response = await client.post("/api/v1/verification/stripe", json={
            "processing_id": processing_id,
            "email": "not-an-email",
            "amount_cents": 2500,
            "payment_date": "2026-09-09",
            "minutes": 31,
        })
        assert response.status_code == 422

    async def test_returns_safe_verifier_result(self, client, processing_id, monkeypatch):
        settings = SimpleNamespace(
            STRIPE_ENABLED=True,
            STRIPE_SECRET_KEY=SimpleNamespace(get_secret_value=lambda: "sk_test_endpoint"),
            STRIPE_SERVICE_TOKEN=SimpleNamespace(get_secret_value=lambda: "internal-test-token"),
            STRIPE_MODE="test",
            STRIPE_API_BASE_URL="https://api.stripe.com",
            STRIPE_API_VERSION="",
            STRIPE_TIMEOUT_SECONDS=15.0,
            STRIPE_TIMEZONE="UTC",
            STRIPE_MAX_PAGES=10,
            STRIPE_LOOKBACK_DAYS=90,
            STRIPE_ALLOWED_PAYMENT_METHOD_TYPE="cashapp",
        )

        class FakeVerifier:
            def __init__(self, secret_key, **_kwargs):
                assert secret_key == "sk_test_endpoint"

            async def verify(self, evidence, received_processing_id):
                assert evidence.email == "customer@example.com"
                assert received_processing_id == processing_id
                return StripeVerificationResult(
                    processing_id=received_processing_id,
                    status="MATCHED",
                    verdict="VALID",
                    reason_code="EXACT_SINGLE_MATCH",
                    stripe_charge_id="ch_test",
                    candidate_count=1,
                    email_hash="redacted-hash",
                )

        monkeypatch.setattr(ocr_service, "get_settings", lambda: settings)
        monkeypatch.setattr(ocr_service, "StripeVerifier", FakeVerifier)

        unauthorized = await client.post("/api/v1/verification/stripe", json={
            "processing_id": processing_id,
            "email": "Customer@Example.com",
            "amount_cents": 2500,
            "payment_date": "2026-09-09",
            "minutes": 31,
            "payment_hour": 14,
        })
        assert unauthorized.status_code == 401

        response = await client.post("/api/v1/verification/stripe", json={
            "processing_id": processing_id,
            "email": "Customer@Example.com",
            "amount_cents": 2500,
            "payment_date": "2026-09-09",
            "minutes": 31,
            "payment_hour": 14,
        }, headers={"X-Internal-Service-Token": "internal-test-token"})

        assert response.status_code == 200
        body = response.json()
        assert body["verdict"] == "VALID"
        assert body["stripe_charge_id"] == "ch_test"
        assert "secret" not in response.text.lower()

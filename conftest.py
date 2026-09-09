"""
conftest.py — pytest shared fixtures for the WhatsApp Transaction AI Agent.

These fixtures are available to all test modules automatically.
Fixtures are scoped to minimize I/O and side effects.
"""
from __future__ import annotations

import base64
import io
import os
import pytest
from unittest.mock import patch
from PIL import Image


# ---------------------------------------------------------------------------
# Environment isolation — prevents tests from requiring real .env secrets
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def mock_settings_env(monkeypatch):
    """
    Inject safe dummy environment variables for all tests.
    Prevents pydantic-settings from requiring real API keys during testing.
    Real values must never appear here.
    """
    monkeypatch.setenv("GROQ_API_KEY", "test-groq-key-not-real")
    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.setenv("OCR_CONFIDENCE_THRESHOLD", "0.85")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("TEMP_DIR", "/tmp/payguard_test")
    monkeypatch.setenv("MAX_IMAGE_SIZE_MB", "10.0")


@pytest.fixture(autouse=True)
def clear_settings_cache():
    """Clear lru_cache on get_settings between tests to respect monkeypatched env vars."""
    from src.config.settings import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Image fixtures
# ---------------------------------------------------------------------------

def _make_test_image(
    text: str = "Payment Completed",
    size: tuple[int, int] = (400, 200),
    bg_color: str = "white",
    text_color: str = "black",
) -> bytes:
    """
    Generate a minimal synthetic PNG image for testing.
    Does NOT use real client screenshots.
    """
    img = Image.new("RGB", size, color=bg_color)
    # Save as PNG bytes
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def blank_white_image_bytes() -> bytes:
    """Minimal 400x200 white PNG — used for preprocessing and image_utils tests."""
    return _make_test_image()


@pytest.fixture
def blank_white_image_base64(blank_white_image_bytes) -> str:
    """Base64-encoded version of the blank white image."""
    return base64.b64encode(blank_white_image_bytes).decode("utf-8")


@pytest.fixture
def jpeg_magic_bytes_image() -> bytes:
    """Minimal JPEG with correct magic bytes (FF D8 FF) for validation tests."""
    img = Image.new("RGB", (100, 100), color="white")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def oversized_image_bytes() -> bytes:
    """
    Image whose raw bytes exceed MAX_IMAGE_SIZE_MB.
    Uses a large blank PIL image to generate > 10MB of raw data.
    """
    # 4000x4000 RGB = 48MB raw; PNG compresses well, so use raw bytes trick
    return b"\xff\xd8\xff" + b"\x00" * (11 * 1024 * 1024)  # fake oversized JPEG


# ---------------------------------------------------------------------------
# OCR fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_receipt_text() -> str:
    """
    Synthetic payment receipt text that mimics a real Stripe receipt screenshot.
    Does NOT contain real personal data.
    """
    return """
    AQ Digital LLC — Payment Receipt

    Customer: Test User
    Email: testuser@example.com
    Amount: $25.00
    Status: Completed
    Date: 2026-09-09
    Time: 14:31:22 UTC
    Transaction ID: pi_test_synthetic_001
    """


@pytest.fixture
def sample_extracted_fields():
    """Pre-built ExtractedFields instance for unit tests that need one."""
    from src.extraction.extractor import ExtractedFields
    return ExtractedFields(
        email="testuser@example.com",
        amount_cents=2500,
        minutes="31",
        payment_date="2026-09-09",
        customer_name=None,
        status="Completed",
        extraction_warnings=[],
    )


@pytest.fixture
def empty_extracted_fields():
    """ExtractedFields with all fields None — represents a failed extraction."""
    from src.extraction.extractor import ExtractedFields
    return ExtractedFields()


# ---------------------------------------------------------------------------
# Processing ID fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def processing_id() -> str:
    from src.utils.image_utils import generate_processing_id
    return generate_processing_id()

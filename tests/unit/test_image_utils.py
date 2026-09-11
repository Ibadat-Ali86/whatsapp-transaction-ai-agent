"""
tests/unit/test_image_utils.py

Unit tests for image_utils — processing ID generation, base64 decoding,
SHA256 hashing, image validation (magic bytes, size), and temp file lifecycle.
All tests are pure-unit: no network calls, no real OCR.
"""
from __future__ import annotations

import base64
import hashlib
import re
import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path


# ===========================================================================
# Processing ID format
# ===========================================================================

class TestProcessingIdGeneration:
    PATTERN = re.compile(r"^wa-\d{8}-\d{6}-[0-9a-f]{8}$")

    def test_format_matches_spec(self):
        from src.utils.image_utils import generate_processing_id
        pid = generate_processing_id()
        assert self.PATTERN.match(pid), f"Processing ID '{pid}' does not match wa-YYYYMMDD-HHMMSS-<8hex>"

    def test_uniqueness(self):
        from src.utils.image_utils import generate_processing_id
        ids = {generate_processing_id() for _ in range(200)}
        assert len(ids) == 200, "Processing IDs must be unique"

    def test_prefix_is_wa(self):
        from src.utils.image_utils import generate_processing_id
        pid = generate_processing_id()
        assert pid.startswith("wa-")


# ===========================================================================
# Base64 decoding
# ===========================================================================

class TestBase64ToBytes:

    def test_valid_base64_decodes_correctly(self, blank_white_image_bytes, blank_white_image_base64):
        from src.utils.image_utils import base64_to_bytes
        result = base64_to_bytes(blank_white_image_base64)
        assert result == blank_white_image_bytes

    def test_invalid_base64_raises_value_error(self):
        from src.utils.image_utils import base64_to_bytes
        with pytest.raises(ValueError, match="[Ii]nvalid base64"):
            base64_to_bytes("!!!not-valid-base64!!!")

    def test_empty_string_raises_value_error(self):
        from src.utils.image_utils import base64_to_bytes
        with pytest.raises(ValueError):
            base64_to_bytes("")


# ===========================================================================
# SHA256 hashing
# ===========================================================================

class TestSha256:

    def test_hash_is_64_hex_chars(self, blank_white_image_bytes):
        from src.utils.image_utils import compute_sha256
        h = compute_sha256(blank_white_image_bytes)
        assert len(h) == 64
        assert re.match(r"^[0-9a-f]{64}$", h)

    def test_same_input_gives_same_hash(self, blank_white_image_bytes):
        from src.utils.image_utils import compute_sha256
        h1 = compute_sha256(blank_white_image_bytes)
        h2 = compute_sha256(blank_white_image_bytes)
        assert h1 == h2

    def test_different_input_gives_different_hash(self, blank_white_image_bytes):
        from src.utils.image_utils import compute_sha256
        h1 = compute_sha256(blank_white_image_bytes)
        h2 = compute_sha256(blank_white_image_bytes + b"\x00")
        assert h1 != h2

    def test_hash_matches_hashlib(self, blank_white_image_bytes):
        from src.utils.image_utils import compute_sha256
        expected = hashlib.sha256(blank_white_image_bytes).hexdigest()
        assert compute_sha256(blank_white_image_bytes) == expected


class TestPerceptualHash:

    def test_hash_is_compact_hex(self, blank_white_image_bytes):
        from src.utils.image_utils import compute_perceptual_hash
        result = compute_perceptual_hash(blank_white_image_bytes)
        assert re.fullmatch(r"[0-9a-f]{16}", result)

    def test_same_image_is_stable(self, blank_white_image_bytes):
        from src.utils.image_utils import compute_perceptual_hash
        assert compute_perceptual_hash(blank_white_image_bytes) == compute_perceptual_hash(blank_white_image_bytes)


# ===========================================================================
# Image validation — magic bytes and size
# ===========================================================================

class TestValidateImageBytes:

    def test_valid_png_passes(self, blank_white_image_bytes):
        from src.utils.image_utils import validate_image_bytes
        # Should not raise
        validate_image_bytes(blank_white_image_bytes, max_size_mb=10.0)

    def test_valid_jpeg_passes(self, jpeg_magic_bytes_image):
        from src.utils.image_utils import validate_image_bytes
        validate_image_bytes(jpeg_magic_bytes_image, max_size_mb=10.0)

    def test_oversized_raises_value_error(self, oversized_image_bytes):
        from src.utils.image_utils import validate_image_bytes
        with pytest.raises(ValueError, match="[Ss]ize|[Ll]arge|[Ee]xceeds"):
            validate_image_bytes(oversized_image_bytes, max_size_mb=10.0)

    def test_invalid_magic_bytes_raises(self):
        from src.utils.image_utils import validate_image_bytes
        fake_bytes = b"\x00\x01\x02\x03" * 100  # Not a valid image format
        with pytest.raises(ValueError, match="[Uu]nsupported|[Ii]nvalid|[Ff]ormat"):
            validate_image_bytes(fake_bytes, max_size_mb=10.0)

    def test_empty_bytes_raises(self):
        from src.utils.image_utils import validate_image_bytes
        with pytest.raises(ValueError):
            validate_image_bytes(b"", max_size_mb=10.0)

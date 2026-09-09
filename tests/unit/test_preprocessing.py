"""
tests/unit/test_preprocessing.py

Unit tests for ImagePreprocessor — verifies each preprocessing strategy
produces valid PIL images without crashing. No OCR or network calls.
"""
from __future__ import annotations

import pytest
from PIL import Image
import io
from src.ocr.preprocessing import ImagePreprocessor, PreprocessingStrategy
from src.ocr.tesseract_processor import TesseractProcessor


def _bytes_to_pil(image_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(image_bytes))


class TestPreprocessingStrategies:

    def test_none_strategy_returns_image(self, blank_white_image_bytes):
        img = _bytes_to_pil(blank_white_image_bytes)
        preprocessor = ImagePreprocessor()
        result = preprocessor.preprocess(img, PreprocessingStrategy.NONE)
        assert isinstance(result, Image.Image)

    def test_basic_strategy_returns_image(self, blank_white_image_bytes):
        img = _bytes_to_pil(blank_white_image_bytes)
        preprocessor = ImagePreprocessor()
        result = preprocessor.preprocess(img, PreprocessingStrategy.BASIC)
        assert isinstance(result, Image.Image)

    def test_enhanced_strategy_returns_image(self, blank_white_image_bytes):
        img = _bytes_to_pil(blank_white_image_bytes)
        preprocessor = ImagePreprocessor()
        result = preprocessor.preprocess(img, PreprocessingStrategy.ENHANCED)
        assert isinstance(result, Image.Image)

    def test_aggressive_strategy_returns_image(self, blank_white_image_bytes):
        img = _bytes_to_pil(blank_white_image_bytes)
        preprocessor = ImagePreprocessor()
        result = preprocessor.preprocess(img, PreprocessingStrategy.AGGRESSIVE)
        assert isinstance(result, Image.Image)

    def test_basic_produces_grayscale(self, blank_white_image_bytes):
        """BASIC strategy must include grayscale conversion."""
        img = _bytes_to_pil(blank_white_image_bytes)
        preprocessor = ImagePreprocessor()
        result = preprocessor.preprocess(img, PreprocessingStrategy.BASIC)
        assert result.mode == "L", f"Expected grayscale 'L', got '{result.mode}'"

    def test_enhanced_produces_grayscale(self, blank_white_image_bytes):
        img = _bytes_to_pil(blank_white_image_bytes)
        preprocessor = ImagePreprocessor()
        result = preprocessor.preprocess(img, PreprocessingStrategy.ENHANCED)
        assert result.mode == "L"

    def test_strategies_do_not_mutate_original(self, blank_white_image_bytes):
        """Original image must not be modified by preprocessing."""
        img = _bytes_to_pil(blank_white_image_bytes)
        original_mode = img.mode
        original_size = img.size
        preprocessor = ImagePreprocessor()
        preprocessor.preprocess(img, PreprocessingStrategy.ENHANCED)
        assert img.mode == original_mode
        assert img.size == original_size

    def test_all_strategy_values_are_handled(self, blank_white_image_bytes):
        """Every PreprocessingStrategy enum value must be handled without ValueError."""
        img = _bytes_to_pil(blank_white_image_bytes)
        preprocessor = ImagePreprocessor()
        for strategy in PreprocessingStrategy:
            result = preprocessor.preprocess(img, strategy)
            assert isinstance(result, Image.Image), f"Strategy {strategy} returned non-Image"


class TestTesseractCandidateQuality:

    def test_receipt_shaped_text_scores_higher_than_unstructured_text(self):
        receipt = (
            "Email test@example.com Amount $25.00 "
            "Time: 14:31:00 UTC Date: 2026-09-09 Status Completed"
        )
        assert TesseractProcessor._field_quality(receipt) == 5
        assert TesseractProcessor._field_quality("random OCR text") == 0

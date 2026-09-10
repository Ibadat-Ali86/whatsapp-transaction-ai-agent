from types import SimpleNamespace

from src.ai.provider import AIProviderError
from src.ocr import engine
from src.ocr.engine import OCREngine
from src.ocr.tesseract_processor import TesseractResult


def test_ai_provider_failure_returns_tesseract_result(monkeypatch):
    settings = SimpleNamespace(
        AI_PROVIDER="groq",
        MAX_IMAGE_SIZE_MB=10.0,
        OCR_CONFIDENCE_THRESHOLD=0.85,
    )
    tesseract_result = TesseractResult(
        raw_text="Payment amount $25.00\nDate 2026-09-09\nCompleted",
        confidence=0.42,
        word_count=5,
        processing_time_ms=10,
        preprocessing_strategy="basic",
    )

    class FailingProvider:
        name = "groq"

        def extract_payment_fields(self, _image_bytes, _processing_id):
            raise AIProviderError("groq", retryable=True, safe_message="Groq unavailable")

    monkeypatch.setattr(engine, "get_settings", lambda: settings)
    monkeypatch.setattr(engine, "save_temp_image", lambda *_args: None)
    monkeypatch.setattr(engine, "delete_temp_image", lambda _path: None)
    monkeypatch.setattr(engine.TesseractProcessor, "extract", lambda *_args: tesseract_result)
    monkeypatch.setattr(engine, "get_provider", lambda _name: FailingProvider())

    result = OCREngine.process_image(b"\xff\xd8\xffsynthetic", "wa-test-fallback", "image/jpeg")

    assert result.error is None
    assert result.error_code is None
    assert result.provider == "tesseract"
    assert result.ai_used is False
    assert result.fallback_reason == "AI_PROVIDER_UNAVAILABLE"
    assert result.fields is not None
    assert result.confidence < settings.OCR_CONFIDENCE_THRESHOLD


def test_tesseract_failure_exposes_safe_reason_code(monkeypatch):
    settings = SimpleNamespace(
        AI_PROVIDER="",
        MAX_IMAGE_SIZE_MB=10.0,
        OCR_CONFIDENCE_THRESHOLD=0.85,
    )

    monkeypatch.setattr(engine, "get_settings", lambda: settings)
    monkeypatch.setattr(engine, "save_temp_image", lambda *_args: None)
    monkeypatch.setattr(engine, "delete_temp_image", lambda _path: None)

    def fail_extract(*_args):
        from src.ocr.tesseract_processor import OCRError

        raise OCRError("tesseract", retryable=False, safe_message="No text extracted")

    monkeypatch.setattr(engine.TesseractProcessor, "extract", fail_extract)

    result = OCREngine.process_image(b"\xff\xd8\xffsynthetic", "wa-test-tesseract-error", "image/jpeg")

    assert result.error is not None
    assert result.error_code == "NO_TEXT_EXTRACTED"
    assert result.fallback_reason is None


def test_ai_provider_initialization_failure_returns_tesseract_result(monkeypatch):
    settings = SimpleNamespace(
        AI_PROVIDER="groq",
        MAX_IMAGE_SIZE_MB=10.0,
        OCR_CONFIDENCE_THRESHOLD=0.85,
    )
    tesseract_result = TesseractResult(
        raw_text="Payment amount $25.00",
        confidence=0.42,
        word_count=3,
        processing_time_ms=10,
        preprocessing_strategy="basic",
    )

    monkeypatch.setattr(engine, "get_settings", lambda: settings)
    monkeypatch.setattr(engine, "save_temp_image", lambda *_args: None)
    monkeypatch.setattr(engine, "delete_temp_image", lambda _path: None)
    monkeypatch.setattr(engine.TesseractProcessor, "extract", lambda *_args: tesseract_result)
    monkeypatch.setattr(engine, "GroqVisionProvider", lambda: (_ for _ in ()).throw(RuntimeError("invalid key")))

    result = OCREngine.process_image(b"\xff\xd8\xffsynthetic", "wa-test-provider-init", "image/jpeg")

    assert result.error is None
    assert result.provider == "tesseract"
    assert result.fallback_reason == "AI_PROVIDER_CONFIGURATION_ERROR"

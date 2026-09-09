import time
import io
import re
import pytesseract
from PIL import Image
from dataclasses import dataclass
from src.ocr.preprocessing import ImagePreprocessor, PreprocessingStrategy
from src.logging.audit import AuditLogger
from src.config.settings import get_settings

logger = AuditLogger("tesseract")

@dataclass
class TesseractResult:
    raw_text: str
    confidence: float
    word_count: int
    processing_time_ms: int
    preprocessing_strategy: str

class OCRError(Exception):
    def __init__(self, component: str, retryable: bool, safe_message: str):
        self.component = component
        self.retryable = retryable
        self.safe_message = safe_message
        super().__init__(self.safe_message)

class TesseractProcessor:
    @staticmethod
    def _field_quality(raw_text: str) -> int:
        """Prefer candidates whose text has recognizable payment fields.

        Tesseract's aggregate word confidence can be high even when a small
        screenshot contains a wrong amount or date. This bounded score is a
        deterministic tie-breaker that rewards receipt-shaped text without
        treating field presence as proof of correctness.
        """
        patterns = (
            r"[\w.%+\-]+@[\w.\-]+\.[A-Za-z]{2,}",
            r"\$\s*\d+(?:\.\d{2})?",
            r"\b\d{1,2}:[0-5]\d(?::[0-5]\d)?\b",
            r"\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b",
            r"\b(?:completed|success|paid|failed|pending|declined)\b",
        )
        return sum(bool(re.search(pattern, raw_text, re.IGNORECASE)) for pattern in patterns)

    def extract(self, image_bytes: bytes, processing_id: str) -> TesseractResult:
        settings = get_settings()
        start_time = time.time()
        try:
            image = Image.open(io.BytesIO(image_bytes))
        except Exception as e:
            raise OCRError('tesseract', retryable=False, safe_message='Invalid image format') from e

        # Upscaling is important for phone screenshots with compact text. Keep
        # the simpler strategies as fallbacks for already-large images.
        strategies_to_try = [
            PreprocessingStrategy.AGGRESSIVE,
            PreprocessingStrategy.BASIC,
            PreprocessingStrategy.ENHANCED,
        ]
        best_result = None
        best_quality = -1

        for strategy in strategies_to_try:
            processed_image = ImagePreprocessor.preprocess(image, strategy)
            try:
                # Get raw text
                raw_text = pytesseract.image_to_string(processed_image)
                # Get data for confidence
                data = pytesseract.image_to_data(processed_image, output_type=pytesseract.Output.DICT)
                
                confidences = [int(c) for c in data['conf'] if c != '-1']
                confidence = sum(confidences) / len(confidences) / 100.0 if confidences else 0.0
                word_count = len(confidences)

                duration_ms = int((time.time() - start_time) * 1000)
                
                result = TesseractResult(
                    raw_text=raw_text,
                    confidence=confidence,
                    word_count=word_count,
                    processing_time_ms=duration_ms,
                    preprocessing_strategy=strategy.name
                )

                quality = self._field_quality(raw_text)
                if (
                    best_result is None
                    or quality > best_quality
                    or (quality == best_quality and result.confidence > best_result.confidence)
                ):
                    best_result = result
                    best_quality = quality

                if (
                    result.confidence >= settings.OCR_CONFIDENCE_THRESHOLD
                    and quality >= 4
                ):
                    return result

            except pytesseract.TesseractNotFoundError as e:
                raise OCRError('tesseract', retryable=False, safe_message='Tesseract not found') from e
            except Exception as e:
                logger.log_error("TESSERACT_EXTRACTION_FAILED", "UNKNOWN_ERROR", processing_id, safe_details=str(e))
                raise OCRError('tesseract', retryable=False, safe_message='Tesseract processing failed') from e

        if best_result is None:
            raise OCRError('tesseract', retryable=False, safe_message='No text extracted')
            
        return best_result

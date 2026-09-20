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
        quality = sum(bool(re.search(pattern, raw_text, re.IGNORECASE)) for pattern in patterns)
        if re.search(r'\bpayment\s+(?:identifier|id)|\btransaction\s+(?:identifier|id)', raw_text, re.IGNORECASE):
            quality += 1
        # Prefer OCR variants that contain a token adjacent to the explicit
        # payment-identifier label. This catches receipts where OCR reverses
        # the visual label/value order and preserves the strongest lookup hint.
        if re.search(
            r'(?:payment\s+(?:identifier|id)|transaction\s+(?:identifier|id))\s*\n?\s*[A-Za-z0-9][A-Za-z0-9_-]{3,127}'
            r'|[A-Za-z0-9][A-Za-z0-9_-]{3,127}\s*\n?\s*(?:payment\s+(?:identifier|id)|transaction\s+(?:identifier|id))',
            raw_text,
            re.IGNORECASE,
        ):
            quality += 1
        return quality

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
                def run_variant(config=''):
                    raw_text = pytesseract.image_to_string(processed_image, config=config)
                    data = pytesseract.image_to_data(
                        processed_image,
                        config=config,
                        output_type=pytesseract.Output.DICT,
                    )
                    confidences = [int(c) for c in data['conf'] if c != '-1']
                    confidence = sum(confidences) / len(confidences) / 100.0 if confidences else 0.0
                    return TesseractResult(
                        raw_text=raw_text,
                        confidence=confidence,
                        word_count=len(confidences),
                        processing_time_ms=int((time.time() - start_time) * 1000),
                        preprocessing_strategy=strategy.name,
                    )

                result = run_variant()
                quality = self._field_quality(result.raw_text)

                # Sparse receipt layouts often put the payment identifier on
                # the line before its label. Run one bounded alternate layout
                # pass when the normal pass is not fully receipt-shaped, then
                # retain whichever output exposes more payment fields. This
                # improves identifier recovery without sending every image to
                # the cloud model.
                if quality < 5:
                    alternate = run_variant('--psm 11')
                    alternate_quality = self._field_quality(alternate.raw_text)
                    if alternate_quality > quality or (
                        alternate_quality == quality and alternate.confidence > result.confidence
                    ):
                        result = alternate
                        quality = alternate_quality

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

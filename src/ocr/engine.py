import time
from typing import Optional
from dataclasses import dataclass
from src.logging.audit import AuditLogger
from src.config.settings import get_settings
from src.utils.image_utils import validate_image_bytes, save_temp_image, delete_temp_image
from src.ocr.tesseract_processor import TesseractProcessor, OCRError
from src.extraction.extractor import FieldExtractor, ExtractedFields
from src.ai.provider import VisionProvider, AIProviderError
from src.ai.groq_provider import GroqVisionProvider
from src.ai.gemini_provider import GeminiVisionProvider

logger = AuditLogger("ocr_engine")

@dataclass
class OCRResult:
    processing_id: str
    provider: str
    raw_text: str
    fields: Optional[ExtractedFields]
    confidence: float
    tesseract_confidence: Optional[float]
    ai_used: bool
    processing_time_ms: int
    error: Optional[str]
    fallback_reason: Optional[str] = None
    error_code: Optional[str] = None

class ConfigurationError(Exception):
    pass

def get_provider(provider_name: str) -> VisionProvider:
    try:
        if provider_name == 'groq':
            return GroqVisionProvider()
        elif provider_name == 'gemini':
            return GeminiVisionProvider()
        else:
            raise ConfigurationError(f"Unknown AI provider: {provider_name}")
    except ConfigurationError:
        raise
    except Exception as e:
        raise ConfigurationError("AI provider initialization failed") from e

class OCREngine:
    @staticmethod
    def process_image(image_bytes: bytes, processing_id: str, mime_type: str) -> OCRResult:
        settings = get_settings()
        start_time = time.time()
        temp_path = None
        
        try:
            validate_image_bytes(image_bytes, settings.MAX_IMAGE_SIZE_MB)
            temp_path = save_temp_image(image_bytes, processing_id, mime_type)
            
            tess_processor = TesseractProcessor()
            tess_result = tess_processor.extract(image_bytes, processing_id)
            
            fields = FieldExtractor.extract_from_text(tess_result.raw_text, processing_id)
            confidence = FieldExtractor.compute_confidence(fields)
            
            if confidence >= settings.OCR_CONFIDENCE_THRESHOLD:
                duration = int((time.time() - start_time) * 1000)
                return OCRResult(
                    processing_id=processing_id,
                    provider='tesseract',
                    raw_text=tess_result.raw_text,
                    fields=fields,
                    confidence=confidence,
                    tesseract_confidence=tess_result.confidence,
                    ai_used=False,
                    processing_time_ms=duration,
                    error=None
                )
                
            if settings.AI_PROVIDER:
                logger.log_event("AI_FALLBACK", "INFO", processing_id, safe_details="Invoking cloud AI fallback — image will be transmitted externally")
                provider = get_provider(settings.AI_PROVIDER)
                ai_result = provider.extract_payment_fields(image_bytes, processing_id)
                
                ai_fields = FieldExtractor.extract_from_ai_response(ai_result.fields, processing_id)
                ai_confidence = FieldExtractor.compute_confidence(ai_fields)
                
                duration = int((time.time() - start_time) * 1000)
                return OCRResult(
                    processing_id=processing_id,
                    provider=provider.name,
                    raw_text=ai_result.raw_text,
                    fields=ai_fields,
                    confidence=ai_confidence,
                    tesseract_confidence=tess_result.confidence,
                    ai_used=True,
                    processing_time_ms=duration,
                    error=None
                )
                
            # If no AI provider and threshold not met, return Tesseract results anyway
            duration = int((time.time() - start_time) * 1000)
            return OCRResult(
                processing_id=processing_id,
                provider='tesseract',
                raw_text=tess_result.raw_text,
                fields=fields,
                confidence=confidence,
                tesseract_confidence=tess_result.confidence,
                ai_used=False,
                processing_time_ms=duration,
                error=None
            )
                
        except AIProviderError as e:
            # Cloud AI is an optional enrichment layer. A rate limit, timeout,
            # or provider outage must not discard the deterministic Tesseract
            # result already extracted from the image. The caller still sees
            # the confidence score and must not auto-approve low-confidence
            # financial evidence.
            logger.log_error(
                "AI_FALLBACK",
                "PROVIDER_UNAVAILABLE",
                processing_id,
                safe_details=f"provider={e.component}; retryable={e.retryable}",
                retryable=e.retryable,
            )
            duration = int((time.time() - start_time) * 1000)
            return OCRResult(
                processing_id=processing_id,
                provider='tesseract',
                raw_text=tess_result.raw_text,
                fields=fields,
                confidence=confidence,
                tesseract_confidence=tess_result.confidence,
                ai_used=False,
                processing_time_ms=duration,
                error=None,
                fallback_reason='AI_PROVIDER_UNAVAILABLE',
            )
        except ConfigurationError as e:
            logger.log_error(
                "AI_FALLBACK",
                "CONFIGURATION_ERROR",
                processing_id,
                safe_details="configured AI provider is unavailable",
            )
            duration = int((time.time() - start_time) * 1000)
            return OCRResult(
                processing_id=processing_id,
                provider='tesseract',
                raw_text=tess_result.raw_text,
                fields=fields,
                confidence=confidence,
                tesseract_confidence=tess_result.confidence,
                ai_used=False,
                processing_time_ms=duration,
                error=None,
                fallback_reason='AI_PROVIDER_CONFIGURATION_ERROR',
            )
        except Exception as e:
            duration = int((time.time() - start_time) * 1000)
            error_code = 'OCR_PROCESSING_ERROR'
            if isinstance(e, ValueError):
                error_code = 'INVALID_IMAGE'
            elif isinstance(e, OCRError):
                error_code = {
                    'Tesseract not found': 'TESSERACT_NOT_FOUND',
                    'Tesseract processing failed': 'TESSERACT_PROCESSING_FAILED',
                    'No text extracted': 'NO_TEXT_EXTRACTED',
                    'Invalid image format': 'INVALID_IMAGE',
                }.get(e.safe_message, 'TESSERACT_ERROR')
            logger.log_error(
                "PROCESS_IMAGE",
                error_code,
                processing_id,
                safe_details=f"type={type(e).__name__}",
            )
            return OCRResult(
                processing_id=processing_id,
                provider='unknown',
                raw_text='',
                fields=None,
                confidence=0.0,
                tesseract_confidence=0.0,
                ai_used=False,
                processing_time_ms=duration,
                error=str(e),
                error_code=error_code,
            )
        finally:
            if temp_path:
                delete_temp_image(temp_path)

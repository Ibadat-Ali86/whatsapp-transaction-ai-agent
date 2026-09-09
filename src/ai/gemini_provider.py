from src.ai.provider import VisionProvider, AIExtractionResult
from src.logging.audit import AuditLogger

logger = AuditLogger("gemini_provider")

class GeminiVisionProvider(VisionProvider):
    """
    Gemini vision provider implementation.
    This is the planned production provider for post-Phase-1.
    """
    
    @property
    def name(self) -> str:
        return 'gemini'

    def extract_payment_fields(self, image_bytes: bytes, processing_id: str) -> AIExtractionResult:
        raise NotImplementedError('Gemini provider not yet implemented. Phase 1 uses Groq.')
        
    def health_check(self) -> bool:
        logger.log_event("HEALTH_CHECK", "FAIL", "system", safe_details="Gemini provider not yet implemented")
        return False

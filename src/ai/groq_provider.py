import time
import json
import base64
from json import JSONDecodeError
from typing import Dict, Any
from groq import Groq
from src.ai.provider import VisionProvider, AIExtractionResult, AIProviderError
from src.config.settings import get_settings
from src.logging.audit import AuditLogger

logger = AuditLogger("groq_provider")

PROMPT = """You are a payment receipt OCR assistant. Extract payment information from this screenshot.

Return ONLY valid JSON with these exact keys (use null for missing fields):
{
  "email": "<email address or null>",
  "amount": "<amount string like '$25.00' or null>",
  "minutes": "<2-digit minute component of payment time, e.g. '31', or null>",
  "payment_hour": "<24-hour local payment hour 0-23, or null>",
  "payment_date": "<date in YYYY-MM-DD format or null>",
  "customer_name": "<customer name or null>",
  "status": "<payment status text like 'Completed' or null>"
}

Return ONLY the JSON object. No explanation, no markdown."""


def parse_json_object(raw_text: str) -> Dict[str, Any]:
    """Parse a JSON object even if a model adds a wrapper around it."""
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise ValueError("AI response was empty")

    clean_text = raw_text.strip()
    clean_text = clean_text.replace('```json', '').replace('```', '').strip()

    # Reasoning-capable models may emit a think/analysis block despite the
    # requested output format. Remove those blocks before parsing the result.
    for opening, closing in (("<think>", "</think>"), ("<analysis>", "</analysis>")):
        while opening in clean_text and closing in clean_text:
            start = clean_text.index(opening)
            end = clean_text.index(closing, start) + len(closing)
            clean_text = (clean_text[:start] + clean_text[end:]).strip()

    decoder = json.JSONDecoder()
    for index, character in enumerate(clean_text):
        if character != '{':
            continue
        try:
            parsed, _ = decoder.raw_decode(clean_text[index:])
        except JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            raise ValueError("AI response was not a JSON object")
        return parsed

    raise ValueError("AI response did not contain a valid JSON object")

class GroqVisionProvider(VisionProvider):
    def __init__(self) -> None:
        self.settings = get_settings()
        api_key = self.settings.GROQ_API_KEY.get_secret_value()
        self.client = Groq(api_key=api_key) if api_key else None

    @property
    def name(self) -> str:
        return 'groq'

    def extract_payment_fields(self, image_bytes: bytes, processing_id: str) -> AIExtractionResult:
        if not self.client:
            raise AIProviderError('groq', retryable=False, safe_message='GROQ_API_KEY is not configured')

        start_time = time.time()
        logger.log_event("AI_EXTRACTION", "START", processing_id, safe_details="Invoking cloud AI fallback — image will be transmitted externally")
        
        base64_image = base64.b64encode(image_bytes).decode('utf-8')
        
        try:
            response = self.client.chat.completions.create(
                model=self.settings.GROQ_VISION_MODEL,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": PROMPT},
                            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}}
                        ]
                    }
                ],
                # Qwen 3.6 supports JSON Object Mode. This prevents normal
                # model prose/reasoning from being mixed into the extraction.
                response_format={"type": "json_object"},
                timeout=30.0,
                temperature=0.0
            )
            
            raw_text = response.choices[0].message.content or ""
            
            # Parse defensively because provider responses can still be
            # wrapped by compatibility layers or contain model artifacts.
            try:
                fields = parse_json_object(raw_text)
            except (JSONDecodeError, ValueError) as parse_error:
                logger.log_error(
                    "AI_EXTRACTION",
                    "JSON_PARSE_ERROR",
                    processing_id,
                    safe_details=str(parse_error),
                )
                raise AIProviderError(
                    'groq',
                    retryable=False,
                    safe_message='Groq returned invalid structured output',
                ) from parse_error

            duration_ms = int((time.time() - start_time) * 1000)
            
            return AIExtractionResult(
                provider_name=self.name,
                raw_text=raw_text,
                fields=fields,
                confidence=1.0 if fields else 0.0,
                processing_time_ms=duration_ms,
                model_used=self.settings.GROQ_VISION_MODEL
            )

        except Exception as e:
            error_msg = str(e).lower()
            status_code = getattr(e, 'status_code', None) or getattr(e, 'status', None)
            retryable_statuses = {408, 409, 425, 429, 500, 502, 503, 504}
            retryable = (
                status_code in retryable_statuses
                or "rate limit" in error_msg
                or "timeout" in error_msg
                or "connection" in error_msg
            )
            logger.log_error(
                "AI_EXTRACTION",
                "API_ERROR",
                processing_id,
                safe_details=f"type={type(e).__name__}; status={status_code or 'unknown'}; retryable={retryable}",
            )
            raise AIProviderError('groq', retryable=retryable, safe_message='Groq API request failed') from e

    def health_check(self) -> bool:
        if not self.client:
            return False
        try:
            self.client.models.list()
            return True
        except Exception as e:
            logger.log_error("HEALTH_CHECK", "FAIL", "system", safe_details=str(e))
            return False

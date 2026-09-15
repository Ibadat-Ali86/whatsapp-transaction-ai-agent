import asyncio
import hashlib
import time
import secrets
from datetime import date, datetime, timezone
import uvicorn
from fastapi import FastAPI, Header, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from contextlib import asynccontextmanager
from typing import Optional

from src.config.settings import get_settings
from src.logging.audit import AuditLogger
from src.utils.image_utils import generate_processing_id, base64_to_bytes, compute_sha256, compute_perceptual_hash
from src.ocr.engine import OCREngine
from src.verification.stripe_verifier import (
    PaymentEvidence,
    StripeVerificationRuntime,
    StripeVerifier,
    normalize_email,
    normalize_transaction_id,
)

logger = AuditLogger("ocr_service")

_stripe_runtime: Optional[StripeVerificationRuntime] = None
_stripe_runtime_signature: Optional[tuple[object, ...]] = None


def _get_stripe_runtime(settings, secret_key: str) -> StripeVerificationRuntime:
    """Return shared Stripe controls for this account/configuration.

    The endpoint creates lightweight verifier objects per request, so the
    runtime must live outside the request handler for caching and throttling
    to protect all concurrent WhatsApp groups in this service process.
    """
    global _stripe_runtime, _stripe_runtime_signature

    cache_ttl_seconds = float(getattr(settings, "STRIPE_CACHE_TTL_SECONDS", 10.0))
    cache_max_entries = int(getattr(settings, "STRIPE_CACHE_MAX_ENTRIES", 512))
    requests_per_second = float(getattr(settings, "STRIPE_REQUESTS_PER_SECOND", 20.0))
    max_concurrent_requests = int(getattr(settings, "STRIPE_MAX_CONCURRENT_REQUESTS", 5))
    signature = (
        hashlib.sha256(secret_key.encode("utf-8")).hexdigest()[:16],
        getattr(settings, "STRIPE_MODE", "test"),
        getattr(settings, "STRIPE_API_BASE_URL", "https://api.stripe.com"),
        cache_ttl_seconds,
        cache_max_entries,
        requests_per_second,
        max_concurrent_requests,
    )
    if _stripe_runtime is None or _stripe_runtime_signature != signature:
        _stripe_runtime = StripeVerificationRuntime(
            cache_ttl_seconds=cache_ttl_seconds,
            cache_max_entries=cache_max_entries,
            requests_per_second=requests_per_second,
            max_concurrent_requests=max_concurrent_requests,
        )
        _stripe_runtime_signature = signature
    return _stripe_runtime

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.log_event("STARTUP", "SUCCESS", "system", safe_details="OCR Service starting")
    yield
    logger.log_event("SHUTDOWN", "SUCCESS", "system", safe_details="OCR Service shutting down")

app = FastAPI(lifespan=lifespan)

class OCRRequest(BaseModel):
    processing_id: Optional[str] = None
    image_base64: str
    mime_type: str = Field(..., pattern="^image/(jpeg|png|webp)$")
    message_id: str
    group_id: str
    sender_jid: str
    caption_email: Optional[str] = None


class StripeVerificationRequest(BaseModel):
    processing_id: str = Field(..., min_length=1, max_length=128)
    email: Optional[str] = Field(default=None, min_length=3, max_length=512)
    transaction_id: Optional[str] = Field(default=None, min_length=4, max_length=128)
    amount_cents: Optional[int] = Field(default=None, gt=0, le=100_000_000)
    payment_date: Optional[date] = None
    minutes: Optional[int] = Field(default=None, ge=0, le=59)
    payment_hour: Optional[int] = Field(default=None, ge=0, le=23)
    payment_month: Optional[int] = Field(default=None, ge=1, le=12)
    payment_day: Optional[int] = Field(default=None, ge=1, le=31)
    currency: str = Field(default="usd", min_length=3, max_length=3)
    payment_method_type: str = Field(default="cashapp", min_length=1, max_length=32)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: Optional[str]) -> Optional[str]:
        if value is None or not value.strip():
            return None
        return normalize_email(value)

    @field_validator("transaction_id")
    @classmethod
    def normalize_transaction_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None or not value.strip():
            return None
        return normalize_transaction_id(value)

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        normalized = value.casefold()
        if not normalized.isalpha():
            raise ValueError("currency must contain letters only")
        return normalized

    @field_validator("payment_method_type")
    @classmethod
    def normalize_payment_method_type(cls, value: str) -> str:
        return value.strip().casefold()

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    processing_id = request.headers.get("X-Processing-Id", generate_processing_id())
    
    response = await call_next(request)
    
    duration_ms = int((time.time() - start_time) * 1000)
    logger.log_event(
        "HTTP_REQUEST",
        "COMPLETED",
        processing_id,
        safe_details=f"Method: {request.method} Path: {request.url.path} Status: {response.status_code}",
        duration_ms=duration_ms
    )
    
    return response

@app.post("/api/v1/ocr/process")
async def process_ocr(request: OCRRequest):
    proc_id = request.processing_id or generate_processing_id()
    
    try:
        image_bytes = base64_to_bytes(request.image_base64)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid base64 string")

    image_sha256 = compute_sha256(image_bytes)
    try:
        image_phash = compute_perceptual_hash(image_bytes)
    except Exception:
        # OCR remains usable for an unusual image decoder failure; exact hash
        # duplicate detection still works in the WhatsApp adapter.
        image_phash = None
        
    # Tesseract and the optional AI fallback are synchronous and may perform
    # subprocess/network work. Keep them off FastAPI's event loop so health,
    # authentication, and verification requests remain responsive while an
    # image is being processed.
    result = await asyncio.to_thread(
        OCREngine.process_image,
        image_bytes,
        proc_id,
        request.mime_type,
    )
    
    if result.error:
        # Do not leak internal error info
        return JSONResponse(
            status_code=500,
            content={
                "error": "Processing failed",
                "verdict": "UNCLEAR",
                "reason_code": result.error_code or "OCR_PROCESSING_ERROR",
            },
        )
        
    # Serialize ExtractedFields
    fields_dict = None
    if result.fields:
        fields_dict = {
            "email": result.fields.email,
            "transaction_id": result.fields.transaction_id,
            "amount_cents": result.fields.amount_cents,
            "minutes": result.fields.minutes,
            "payment_hour": result.fields.payment_hour,
            "payment_date": result.fields.payment_date,
            "payment_month": result.fields.payment_month,
            "payment_day": result.fields.payment_day,
            "customer_name": result.fields.customer_name,
            "status": result.fields.status,
            "extraction_warnings": result.fields.extraction_warnings
        }
        
    response_data = {
        "processing_id": result.processing_id,
        "provider": result.provider,
        "raw_text": result.raw_text,
        "fields": fields_dict,
        "confidence": result.confidence,
        "tesseract_confidence": result.tesseract_confidence,
        "ai_used": result.ai_used,
        "processing_time_ms": result.processing_time_ms,
        "image_sha256": image_sha256,
        "image_phash": image_phash,
    }
    if result.fallback_reason:
        response_data["fallback_reason"] = result.fallback_reason
    
    return JSONResponse(content=response_data)


@app.post("/api/v1/verification/stripe")
async def verify_stripe(
    request: StripeVerificationRequest,
    internal_service_token: Optional[str] = Header(default=None, alias="X-Internal-Service-Token"),
):
    settings = get_settings()
    if not settings.STRIPE_ENABLED:
        raise HTTPException(status_code=503, detail="Stripe verification is disabled")
    configured_service_token = settings.STRIPE_SERVICE_TOKEN.get_secret_value()
    if not configured_service_token:
        raise HTTPException(status_code=503, detail="Stripe verification is not configured")
    if not internal_service_token or not secrets.compare_digest(internal_service_token, configured_service_token):
        raise HTTPException(status_code=401, detail="Unauthorized")

    secret_key = settings.STRIPE_SECRET_KEY.get_secret_value()
    verifier = StripeVerifier(
        secret_key,
        mode=settings.STRIPE_MODE,
        base_url=settings.STRIPE_API_BASE_URL,
        api_version=settings.STRIPE_API_VERSION,
        timeout_seconds=settings.STRIPE_TIMEOUT_SECONDS,
        timezone_name=settings.STRIPE_TIMEZONE,
        screenshot_timezone=settings.STRIPE_SCREENSHOT_TIMEZONE,
        max_pages=settings.STRIPE_MAX_PAGES,
        lookback_days=settings.STRIPE_LOOKBACK_DAYS,
        allowed_payment_method_type=settings.STRIPE_ALLOWED_PAYMENT_METHOD_TYPE,
        cache_ttl_seconds=float(getattr(settings, "STRIPE_CACHE_TTL_SECONDS", 10.0)),
        cache_max_entries=int(getattr(settings, "STRIPE_CACHE_MAX_ENTRIES", 512)),
        requests_per_second=float(getattr(settings, "STRIPE_REQUESTS_PER_SECOND", 20.0)),
        max_concurrent_requests=int(getattr(settings, "STRIPE_MAX_CONCURRENT_REQUESTS", 5)),
        retry_attempts=int(getattr(settings, "STRIPE_RETRY_ATTEMPTS", 2)),
        backoff_base_seconds=float(getattr(settings, "STRIPE_BACKOFF_BASE_SECONDS", 0.5)),
        backoff_max_seconds=float(getattr(settings, "STRIPE_BACKOFF_MAX_SECONDS", 8.0)),
        runtime=_get_stripe_runtime(settings, secret_key),
    )
    evidence = PaymentEvidence(
        email=request.email,
        transaction_id=request.transaction_id,
        amount_cents=request.amount_cents,
        payment_date=request.payment_date,
        minutes=request.minutes,
        payment_hour=request.payment_hour,
        payment_month=request.payment_month,
        payment_day=request.payment_day,
        currency=request.currency,
        payment_method_type=request.payment_method_type,
    )
    result = await verifier.verify(evidence, request.processing_id)
    if result.status == "ERROR":
        return JSONResponse(status_code=503, content=result.as_dict())
    return JSONResponse(content=result.as_dict())

@app.get("/health/live")
async def health_live():
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

@app.get("/health/ready")
async def health_ready():
    import pytesseract
    try:
        pytesseract.get_tesseract_version()
        tesseract_ok = True
        status = "ok"
    except Exception:
        tesseract_ok = False
        status = "degraded"
        
    return {
        "status": status,
        "tesseract": tesseract_ok,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

if __name__ == "__main__":
    settings = get_settings()
    uvicorn.run(app, host=settings.OCR_SERVICE_HOST, port=settings.OCR_SERVICE_PORT)

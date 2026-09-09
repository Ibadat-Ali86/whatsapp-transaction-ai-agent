import time
from datetime import datetime, timezone
import uvicorn
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
from typing import Optional

from src.config.settings import get_settings
from src.logging.audit import AuditLogger
from src.utils.image_utils import generate_processing_id, base64_to_bytes
from src.ocr.engine import OCREngine

logger = AuditLogger("ocr_service")

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
        
    result = OCREngine.process_image(image_bytes, proc_id, request.mime_type)
    
    if result.error:
        # Do not leak internal error info
        return JSONResponse(status_code=500, content={"error": "Processing failed", "verdict": "UNCLEAR"})
        
    # Serialize ExtractedFields
    fields_dict = None
    if result.fields:
        fields_dict = {
            "email": result.fields.email,
            "amount_cents": result.fields.amount_cents,
            "minutes": result.fields.minutes,
            "payment_date": result.fields.payment_date,
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
        "processing_time_ms": result.processing_time_ms
    }
    
    return JSONResponse(content=response_data)

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

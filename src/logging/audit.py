import logging
import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

class JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_data: Dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "message": record.getMessage()
        }
        if hasattr(record, "audit_data"):
            log_data.update(getattr(record, "audit_data"))
            
        return json.dumps(log_data)

def get_logger(component: str) -> logging.Logger:
    logger = logging.getLogger(f"audit.{component}")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(JSONFormatter())
        logger.addHandler(handler)
        logger.propagate = False
    return logger

class AuditLogger:
    def __init__(self, component: str):
        self.logger = get_logger(component)
        self.component = component

    def _log(self, level: int, event: str, status: str, processing_id: str, **kwargs: Any) -> None:
        audit_data = {
            "processing_id": processing_id,
            "component": self.component,
            "event": event,
            "status": status,
        }
        
        for key in ["duration_ms", "provider", "message_id", "group_id_hash", "verdict", "error_code", "safe_details"]:
            if key in kwargs and kwargs[key] is not None:
                audit_data[key] = kwargs[key]
                
        self.logger.log(level, f"{event}: {status}", extra={"audit_data": audit_data})

    def log_event(self, event: str, status: str, processing_id: str, **kwargs: Any) -> None:
        self._log(logging.INFO, event, status, processing_id, **kwargs)

    def log_error(self, event: str, error_code: str, processing_id: str, safe_details: Optional[str] = None, **kwargs: Any) -> None:
        self._log(logging.ERROR, event, "ERROR", processing_id, error_code=error_code, safe_details=safe_details, **kwargs)

    def log_ocr_result(self, processing_id: str, provider: str, verdict: str, duration_ms: int, **kwargs: Any) -> None:
        self._log(logging.INFO, "OCR_COMPLETED", "SUCCESS", processing_id, provider=provider, verdict=verdict, duration_ms=duration_ms, **kwargs)

    def log_verdict(self, processing_id: str, verdict: str, **kwargs: Any) -> None:
        self._log(logging.INFO, "VERDICT_GENERATED", "SUCCESS", processing_id, verdict=verdict, **kwargs)

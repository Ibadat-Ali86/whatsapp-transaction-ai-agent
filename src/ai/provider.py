from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

@dataclass
class AIExtractionResult:
    provider_name: str
    raw_text: str
    fields: dict
    confidence: float
    processing_time_ms: int
    model_used: str

class AIProviderError(Exception):
    def __init__(self, component: str, retryable: bool, safe_message: str):
        self.component = component
        self.retryable = retryable
        self.safe_message = safe_message
        super().__init__(self.safe_message)

class VisionProvider(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        ...
        
    @abstractmethod
    def extract_payment_fields(self, image_bytes: bytes, processing_id: str) -> AIExtractionResult:
        ...
        
    @abstractmethod
    def health_check(self) -> bool:
        ...

from functools import lru_cache
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    AI_PROVIDER: str = 'groq'
    GROQ_API_KEY: SecretStr = SecretStr('')
    GROQ_VISION_MODEL: str = 'meta-llama/llama-4-scout-17b-16e-instruct'
    GEMINI_API_KEY: SecretStr = SecretStr('')
    GEMINI_VISION_MODEL: str = 'gemini-1.5-flash'
    OCR_CONFIDENCE_THRESHOLD: float = 0.85
    LOG_LEVEL: str = 'INFO'
    OCR_SERVICE_HOST: str = '0.0.0.0'
    OCR_SERVICE_PORT: int = 8000
    TEMP_DIR: str = 'tmp'
    MAX_IMAGE_SIZE_MB: float = 10.0

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    def __repr__(self) -> str:
        return f"<Settings AI_PROVIDER={self.AI_PROVIDER}>"

@lru_cache
def get_settings() -> Settings:
    return Settings()

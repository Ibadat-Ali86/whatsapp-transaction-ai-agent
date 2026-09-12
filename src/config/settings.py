from functools import lru_cache
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    AI_PROVIDER: str = 'groq'
    GROQ_API_KEY: SecretStr = SecretStr('')
    GROQ_VISION_MODEL: str = 'qwen/qwen3.6-27b'
    GEMINI_API_KEY: SecretStr = SecretStr('')
    GEMINI_VISION_MODEL: str = 'gemini-1.5-flash'
    OCR_CONFIDENCE_THRESHOLD: float = 0.85
    LOG_LEVEL: str = 'INFO'
    OCR_SERVICE_HOST: str = '0.0.0.0'
    OCR_SERVICE_PORT: int = 8000
    TEMP_DIR: str = 'tmp'
    MAX_IMAGE_SIZE_MB: float = 10.0
    STRIPE_ENABLED: bool = False
    STRIPE_SECRET_KEY: SecretStr = SecretStr('')
    STRIPE_SERVICE_TOKEN: SecretStr = SecretStr('')
    STRIPE_MODE: str = 'test'
    STRIPE_API_BASE_URL: str = 'https://api.stripe.com'
    STRIPE_API_VERSION: str = ''
    STRIPE_TIMEOUT_SECONDS: float = 15.0
    STRIPE_TIMEZONE: str = 'UTC'
    # Optional timezone of receipt clocks. Leave empty when group members may
    # send receipts from different local zones; minute plus amount/date
    # matching remains timezone-independent and fail-closed.
    STRIPE_SCREENSHOT_TIMEZONE: str = ''
    STRIPE_MAX_PAGES: int = 10
    STRIPE_LOOKBACK_DAYS: int = 90
    STRIPE_ALLOWED_PAYMENT_METHOD_TYPE: str = 'cashapp'

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    def __repr__(self) -> str:
        return f"<Settings AI_PROVIDER={self.AI_PROVIDER}>"

@lru_cache
def get_settings() -> Settings:
    return Settings()

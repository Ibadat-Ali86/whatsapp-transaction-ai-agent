import os
import secrets
import pathlib
import base64
import hashlib
import io
import math
from datetime import datetime
from PIL import Image
from src.config.settings import get_settings
from src.logging.audit import AuditLogger

logger = AuditLogger("image_utils")

def generate_processing_id() -> str:
    now = datetime.now().strftime("%Y%m%d-%H%M%S")
    random_hex = secrets.token_hex(4)
    return f"wa-{now}-{random_hex}"

def save_temp_image(image_bytes: bytes, processing_id: str, mime_type: str) -> pathlib.Path:
    settings = get_settings()
    temp_dir = pathlib.Path(settings.TEMP_DIR)
    temp_dir.mkdir(parents=True, exist_ok=True)
    
    ext = mime_type.split("/")[-1]
    if ext == "jpeg":
        ext = "jpg"
    
    file_path = temp_dir / f"{processing_id}.{ext}"
    file_path.write_bytes(image_bytes)
    return file_path

def delete_temp_image(path: pathlib.Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except Exception as e:
        logger.log_error("DELETE_TEMP_IMAGE", "IO_ERROR", "unknown", safe_details=str(e))

def validate_image_bytes(image_bytes: bytes, max_size_mb: float) -> None:
    if len(image_bytes) > max_size_mb * 1024 * 1024:
        raise ValueError(f"Image size exceeds maximum allowed size of {max_size_mb} MB")
        
    # Basic magic byte check for jpg, png, webp
    if not (image_bytes.startswith(b'\xff\xd8\xff') or 
            image_bytes.startswith(b'\x89PNG\r\n\x1a\n') or
            (image_bytes.startswith(b'RIFF') and image_bytes[8:12] == b'WEBP')):
        raise ValueError("Invalid image format or magic bytes")

def compute_sha256(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()

def compute_perceptual_hash(image_bytes: bytes) -> str:
    """Return a compact 64-bit pHash for resized/recompressed image matching."""
    with Image.open(io.BytesIO(image_bytes)) as image:
        grayscale = image.convert("L").resize((32, 32), Image.Resampling.LANCZOS)
        pixels = list(grayscale.getdata())

    coefficients = []
    for u in range(8):
        for v in range(8):
            total = 0.0
            for x in range(32):
                for y in range(32):
                    total += pixels[x * 32 + y] * math.cos(((2 * x + 1) * u * math.pi) / 64) * math.cos(((2 * y + 1) * v * math.pi) / 64)
            alpha_u = 1 / math.sqrt(2) if u == 0 else 1.0
            alpha_v = 1 / math.sqrt(2) if v == 0 else 1.0
            coefficients.append(total * alpha_u * alpha_v / 4)

    median = sorted(coefficients[1:])[len(coefficients[1:]) // 2]
    bits = sum((1 << index) for index, coefficient in enumerate(coefficients) if coefficient > median)
    return f"{bits:016x}"

def base64_to_bytes(b64_str: str) -> bytes:
    if not b64_str or not b64_str.strip():
        raise ValueError("Invalid base64 string: empty payload")
    try:
        return base64.b64decode(b64_str, validate=True)
    except Exception as e:
        raise ValueError("Invalid base64 string") from e

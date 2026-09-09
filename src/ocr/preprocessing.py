from enum import Enum
from PIL import Image, ImageEnhance
from src.logging.audit import AuditLogger

logger = AuditLogger("preprocessing")

class PreprocessingStrategy(Enum):
    NONE = "none"
    BASIC = "basic"
    ENHANCED = "enhanced"
    AGGRESSIVE = "aggressive"

class ImagePreprocessor:
    @staticmethod
    def preprocess(image: Image.Image, strategy: PreprocessingStrategy) -> Image.Image:
        logger.log_event("PREPROCESS_IMAGE", "START", "unknown", safe_details=f"Strategy: {strategy.name}")
        
        if strategy == PreprocessingStrategy.NONE:
            return image
            
        processed_image = image.convert('L')
        
        if strategy in [PreprocessingStrategy.BASIC, PreprocessingStrategy.ENHANCED, PreprocessingStrategy.AGGRESSIVE]:
            enhancer = ImageEnhance.Contrast(processed_image)
            processed_image = enhancer.enhance(1.5)
            
        if strategy in [PreprocessingStrategy.ENHANCED, PreprocessingStrategy.AGGRESSIVE]:
            sharpness_enhancer = ImageEnhance.Sharpness(processed_image)
            processed_image = sharpness_enhancer.enhance(2.0)
            
        if strategy == PreprocessingStrategy.AGGRESSIVE:
            # Resize for ~300 DPI equivalent roughly
            width, height = processed_image.size
            processed_image = processed_image.resize((width * 2, height * 2), Image.Resampling.LANCZOS)
            
        return processed_image

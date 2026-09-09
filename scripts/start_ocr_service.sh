#!/usr/bin/env bash
# scripts/start_ocr_service.sh
# Start the Python FastAPI OCR service for local development.
# Usage: bash scripts/start_ocr_service.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Verify .env exists
if [ ! -f ".env" ]; then
  echo "ERROR: .env file not found."
  echo "  Copy .env.example to .env and fill in your API keys:"
  echo "  cp .env.example .env"
  exit 1
fi

# Verify virtual environment
if [ ! -d ".venv" ]; then
  echo "ERROR: Python virtual environment not found at .venv/"
  echo "  Create it with:"
  echo "  python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi

source .venv/bin/activate

# Verify Tesseract
if ! command -v tesseract &>/dev/null; then
  echo "ERROR: Tesseract is not installed or not in PATH."
  echo "  Install with: sudo apt install tesseract-ocr"
  exit 1
fi

echo "========================================"
echo " WhatsApp Transaction AI Agent"
echo " OCR Service — Starting"
echo " Host: 0.0.0.0:8000"
echo " Tesseract: $(tesseract --version 2>&1 | head -1)"
echo " Python: $(python3 --version)"
echo "========================================"

# Create temp directory if needed
mkdir -p tmp

# Start service
python3 -m uvicorn src.ocr.service:app \
  --host 0.0.0.0 \
  --port 8000 \
  --reload \
  --log-level info

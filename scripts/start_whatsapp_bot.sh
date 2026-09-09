#!/usr/bin/env bash
# scripts/start_whatsapp_bot.sh
# Start the Node.js Baileys WhatsApp bot for local development.
# Usage: bash scripts/start_whatsapp_bot.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Verify .env exists
if [ ! -f ".env" ]; then
  echo "ERROR: .env file not found."
  echo "  Copy .env.example to .env and fill in your settings:"
  echo "  cp .env.example .env"
  exit 1
fi

# Verify node_modules
if [ ! -d "node_modules" ]; then
  echo "ERROR: node_modules not found."
  echo "  Run: npm install"
  exit 1
fi

# Verify Node version
NODE_VERSION=$(node --version | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js >= 20 required. Found: $(node --version)"
  exit 1
fi

# Verify OCR service is reachable
OCR_URL="${OCR_SERVICE_URL:-http://localhost:8000}"
echo "Checking OCR service at $OCR_URL/health/live ..."
if curl -sf "$OCR_URL/health/live" > /dev/null 2>&1; then
  echo "  OCR service: READY"
else
  echo "  WARNING: OCR service not reachable at $OCR_URL"
  echo "  Start it first with: bash scripts/start_ocr_service.sh"
  echo "  Bot will start anyway but OCR calls will fail until service is up."
fi

# Create required directories
mkdir -p auth tmp

echo "========================================"
echo " WhatsApp Transaction AI Agent"
echo " Baileys Bot — Starting"
echo " Node.js: $(node --version)"
echo " Auth dir: auth/"
echo " OCR service: $OCR_URL"
echo "========================================"
echo " Scan the QR code with WhatsApp to link."
echo "========================================"

node src/whatsapp/index.js

#!/usr/bin/env bash
# scripts/run_tests.sh
# Run the full Phase 1 test suite with coverage reporting.
# Usage: bash scripts/run_tests.sh [unit|integration|all]

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

MODE="${1:-all}"

if [ ! -d ".venv" ]; then
  echo "ERROR: .venv not found. Run: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi

source .venv/bin/activate

echo "========================================"
echo " Running tests — mode: $MODE"
echo "========================================"

case "$MODE" in
  unit)
    python3 -m pytest tests/unit/ -v -m unit --cov=src --cov-report=term-missing
    ;;
  integration)
    python3 -m pytest tests/integration/ -v -m integration --cov=src --cov-report=term-missing
    ;;
  accuracy)
    python3 -m tests.accuracy.benchmark
    ;;
  all)
    python3 -m pytest tests/unit/ tests/integration/ -v \
      --cov=src \
      --cov-report=term-missing \
      --cov-report=html:coverage/
    echo ""
    echo "Coverage HTML report: coverage/index.html"
    ;;
  *)
    echo "Usage: $0 [unit|integration|accuracy|all]"
    exit 1
    ;;
esac

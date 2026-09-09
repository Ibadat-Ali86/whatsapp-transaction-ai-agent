"""
tests/accuracy/benchmark.py

OCR accuracy benchmark runner.
Reads labeled fixture files from tests/fixtures/ocr/,
runs each through the OCR engine, and reports field-level accuracy.

Usage:
    python -m tests.accuracy.benchmark

Requires:
    - Tesseract installed
    - tests/fixtures/ocr/ populated with image + expected JSON pairs
    - GROQ_API_KEY if AI fallback fixtures are included

Per docs/OCR_SPEC.md: accuracy must be measured on a labeled dataset,
not claimed from a few successful examples.
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Ensure project root is on sys.path when run as __main__
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


FIXTURES_DIR = PROJECT_ROOT / "tests" / "fixtures" / "ocr"

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

@dataclass
class FieldAccuracy:
    field_name: str
    total: int = 0
    correct: int = 0
    missing_in_expected: int = 0
    false_extractions: int = 0

    @property
    def accuracy(self) -> float:
        if self.total == 0:
            return 0.0
        return self.correct / self.total


@dataclass
class BenchmarkResult:
    fixture_name: str
    expected: dict
    extracted: dict
    provider: str
    processing_time_ms: int
    confidence: float
    ai_used: bool
    field_matches: dict[str, bool] = field(default_factory=dict)


def _normalize(value: Optional[str]) -> Optional[str]:
    """Lowercase + strip for loose string comparison."""
    if value is None:
        return None
    return str(value).strip().lower()


def _compare_amount(expected_cents: Optional[int], actual_cents: Optional[int]) -> bool:
    """Exact integer comparison — no floating-point tolerance."""
    return expected_cents == actual_cents


def run_benchmark() -> None:
    """
    Main benchmark entry point.

    For each fixture:
      1. Load image bytes + expected JSON.
      2. Run OCREngine.process_image.
      3. Compare extracted fields to expected.
      4. Accumulate accuracy metrics.
      5. Print summary report.
    """
    from src.utils.image_utils import generate_processing_id
    from src.ocr.engine import OCREngine

    fixtures = sorted(FIXTURES_DIR.glob("*.json"))

    if not fixtures:
        print(
            "\n[BENCHMARK] No fixture files found in tests/fixtures/ocr/\n"
            "  Add paired <name>.png + <name>.json files to run accuracy tests.\n"
            "  See tests/fixtures/ocr/README.md for the required format.\n"
        )
        return

    results: list[BenchmarkResult] = []
    field_stats: dict[str, FieldAccuracy] = {
        "email": FieldAccuracy("email"),
        "amount_cents": FieldAccuracy("amount_cents"),
        "minutes": FieldAccuracy("minutes"),
        "payment_date": FieldAccuracy("payment_date"),
        "status": FieldAccuracy("status"),
    }

    for json_path in fixtures:
        # Locate the corresponding image file
        image_path = None
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            candidate = json_path.with_suffix(ext)
            if candidate.exists():
                image_path = candidate
                break

        if image_path is None:
            print(f"  [SKIP] No image found for {json_path.name}")
            continue

        with open(json_path) as f:
            expected = json.load(f)

        with open(image_path, "rb") as f:
            image_bytes = f.read()

        mime_map = {".png": "image/png", ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg", ".webp": "image/webp"}
        mime_type = mime_map.get(image_path.suffix.lower(), "image/jpeg")

        pid = generate_processing_id()
        ocr_result = OCREngine.process_image(image_bytes, pid, mime_type)

        extracted = {}
        if ocr_result.fields:
            extracted = {
                "email": ocr_result.fields.email,
                "amount_cents": ocr_result.fields.amount_cents,
                "minutes": ocr_result.fields.minutes,
                "payment_date": ocr_result.fields.payment_date,
                "status": ocr_result.fields.status,
            }

        # Compare fields
        field_matches: dict[str, bool] = {}
        for field_name in field_stats:
            exp_val = expected.get(field_name)
            act_val = extracted.get(field_name)

            field_stats[field_name].total += 1

            if field_name == "amount_cents":
                match = _compare_amount(exp_val, act_val)
            else:
                match = _normalize(exp_val) == _normalize(act_val)

            field_matches[field_name] = match
            if match:
                field_stats[field_name].correct += 1
            elif act_val is not None and exp_val is None:
                field_stats[field_name].false_extractions += 1

        results.append(BenchmarkResult(
            fixture_name=json_path.stem,
            expected=expected,
            extracted=extracted,
            provider=ocr_result.provider,
            processing_time_ms=ocr_result.processing_time_ms,
            confidence=ocr_result.confidence,
            ai_used=ocr_result.ai_used,
            field_matches=field_matches,
        ))

    # ---------------------------------------------------------------------------
    # Print report
    # ---------------------------------------------------------------------------
    print("\n" + "=" * 70)
    print("  OCR ACCURACY BENCHMARK REPORT")
    print("=" * 70)
    print(f"  Fixtures evaluated : {len(results)}")
    print(f"  Fixtures skipped   : {len(fixtures) - len(results)}")
    print()

    for result in results:
        status_icon = "✅" if all(result.field_matches.values()) else "❌"
        print(f"  {status_icon} {result.fixture_name}")
        print(f"      provider={result.provider}  ai_used={result.ai_used}"
              f"  confidence={result.confidence:.2f}  time={result.processing_time_ms}ms")
        for fname, matched in result.field_matches.items():
            icon = "✓" if matched else "✗"
            exp = result.expected.get(fname, "—")
            act = result.extracted.get(fname, "—")
            print(f"      {icon} {fname:15s}  expected={exp!r}  actual={act!r}")
        print()

    print("-" * 70)
    print("  FIELD-LEVEL ACCURACY SUMMARY")
    print("-" * 70)
    for fname, stats in field_stats.items():
        bar = "█" * int(stats.accuracy * 20) + "░" * (20 - int(stats.accuracy * 20))
        print(f"  {fname:15s}  [{bar}]  {stats.accuracy * 100:5.1f}%  "
              f"({stats.correct}/{stats.total} correct)")

    complete_record_count = sum(
        1 for r in results if all(r.field_matches.values())
    )
    complete_accuracy = complete_record_count / len(results) if results else 0.0
    print()
    print(f"  Complete record accuracy: {complete_accuracy * 100:.1f}%"
          f"  ({complete_record_count}/{len(results)} fully correct)")
    print("=" * 70)
    print()
    print("  NOTE: These metrics are a STARTING HEURISTIC per docs/OCR_SPEC.md.")
    print("  Accuracy thresholds must be agreed with the client before production.")
    print()


if __name__ == "__main__":
    run_benchmark()

# OCR Test Fixtures

## Purpose

This directory contains **labeled test fixtures** for the OCR accuracy benchmark.

Per `docs/OCR_SPEC.md`:
> Accuracy must be measured using a labeled test set, not claimed from a few successful examples.

Each fixture is a **pair of files**:

```
<name>.png    ← the screenshot image (synthetic/approved only)
<name>.json   ← the expected extraction result
```

## Expected JSON Format

```json
{
  "email": "testuser@example.com",
  "amount_cents": 2500,
  "minutes": "31",
  "payment_date": "2026-09-09",
  "customer_name": "Test User",
  "status": "Completed"
}
```

**Field rules:**
- `amount_cents` — **integer cents only** (`$25.00` → `2500`). Never float.
- `minutes` — two-digit string `"00"`–`"59"`. Null if not present.
- `payment_date` — ISO 8601 `YYYY-MM-DD`. Null if not present.
- Any field may be `null` if genuinely absent from the screenshot.

## Fixture Categories Required (per TESTING_STRATEGY.md)

| Category | Filename prefix | Status |
|----------|-----------------|--------|
| Clear screenshot | `clear_` | ⬜ Add in Phase 1 |
| Blurry screenshot | `blurry_` | ⬜ Add in Phase 1 |
| Dark screenshot | `dark_` | ⬜ Add in Phase 1 |
| Bright / washed out | `bright_` | ⬜ Add in Phase 1 |
| Rotated | `rotated_` | ⬜ Add in Phase 1 |
| Compressed (JPEG artefacts) | `compressed_` | ⬜ Add in Phase 1 |
| Handwritten email | `handwritten_` | ⬜ Add in Phase 1 |
| Small text email | `smalltext_` | ⬜ Add in Phase 1 |
| Decimal amount | `decimal_` | ⬜ Add in Phase 1 |
| Missing field | `missing_field_` | ⬜ Add in Phase 1 |
| Conflicting fields | `conflict_` | ⬜ Add in Phase 1 |
| Forwarded message | `forwarded_` | ⬜ Add in Phase 1 |
| Duplicate image | `duplicate_` | ⬜ Phase 3 |
| Recompressed duplicate | `recompressed_` | ⬜ Phase 3 |

## Security Rules

- **NEVER** commit real client payment screenshots.
- Use **synthetic screenshots only** (generated programmatically or from test accounts).
- If a screenshot contains real personal data, do **not** add it here.
- The directory `tests/fixtures/ocr/raw_client/` is `.gitignore`d for storing
  temporarily downloaded real images during local testing — never commit that subdirectory.

## Running the Benchmark

```bash
python -m tests.accuracy.benchmark
```

Results are printed to stdout. No files are written. No network calls unless AI fallback is triggered.

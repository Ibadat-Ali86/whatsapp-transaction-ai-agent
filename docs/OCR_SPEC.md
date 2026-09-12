# OCR AND AI EXTRACTION SPECIFICATION

## Objective
Extract payment information from screenshots accurately enough for downstream verification.

## OCR order

1. Tesseract local.
2. Evaluate result.
3. If fallback criteria are met, call configured cloud vision provider.
4. Normalize output.
5. Validate fields.
6. Never treat field presence alone as proof of correctness.

## Tesseract

Tesseract must run locally.

Candidate preprocessing:
- resize;
- grayscale;
- contrast;
- sharpening;
- deskew;
- crop if layout is known.

Do not blindly apply every preprocessing operation. Benchmark them against the labeled dataset.

## Groq development fallback

Groq is used during development because its current API supports multimodal vision models and image understanding/OCR use cases.

Keep the model configurable through GROQ_VISION_MODEL.

Do not hard-code a model name into business logic.

## Gemini future fallback

Gemini must implement the same provider interface.

Switching providers should require configuration, not rewriting verification logic.

## Required extracted fields

email
amount
minutes
payment_date
payment_month
payment_day
customer_name
status

## Confidence

The original project documentation uses a weighted field-presence score with 0.85 as the fallback threshold.

This is a STARTING HEURISTIC, not a validated accuracy metric.

Required future improvement:
- OCR confidence;
- regex validity;
- email syntax;
- amount parse confidence;
- time parse confidence;
- image quality;
- provider agreement;
- field-level correctness on labeled data.

## Test dataset

Maintain:
tests/fixtures/ocr/

Each fixture should have:
- image;
- expected JSON;
- source label;
- difficulty label;
- notes.

Example expected JSON:

{
  "email": "test@example.com",
  "amount_cents": 2500,
  "minutes": "31",
  "payment_date": "2026-09-06",
  "payment_month": null,
  "payment_day": null,
  "status": "Completed"
}

## Accuracy metrics

Track:
- exact email accuracy;
- exact amount accuracy;
- exact minute accuracy;
- date accuracy;
- status accuracy;
- complete-record accuracy;
- false extraction rate;
- fallback rate.

## Safety rule

If required fields are missing or contradictory:
UNCLEAR.

Do not guess.

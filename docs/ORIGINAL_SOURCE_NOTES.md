# ORIGINAL DOCUMENT ALIGNMENT NOTES

The provided original project document defines:
- AQ Digital LLC;
- Stripe/Cash App Pay Phase 1;
- 50+ WhatsApp groups;
- Baileys -> n8n -> OCR -> verification;
- Tesseract primary OCR;
- Gemini fallback;
- Google Sheets logging;
- SHA256 + pHash duplicate detection;
- email + amount + minutes transaction duplicate key;
- Stripe verification;
- Telegram alerts;
- deployment on a VPS.

This documentation package preserves those functional goals.

Explicit owner changes incorporated here:
1. Local Ubuntu development first.
2. No DigitalOcean at the start.
3. Google Sheets instead of PostgreSQL.
4. Groq instead of Gemini for development/testing.
5. Provider abstraction so Gemini can be introduced later.
6. n8n remains part of the final architecture.

Important source assumptions that require engineering validation:
- 85%/90% Tesseract success estimate;
- 0.85 confidence threshold;
- minute-only Stripe matching;
- pHash threshold of 8;
- charge-list limits/pagination;
- cloud AI data handling.

These are not automatically treated as proven facts merely because they appear in the original plan.

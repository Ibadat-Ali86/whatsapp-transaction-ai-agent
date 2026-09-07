# PRODUCT REQUIREMENTS DOCUMENT (PRD)

## 1. Product vision
Automate payment screenshot verification submitted through WhatsApp groups while reducing manual verification work and providing an auditable record of decisions.

## 2. Users
Primary:
- AQ Digital LLC administrators.

Operational participants:
- WhatsApp group members submitting payment screenshots.
- AI/coding agents maintaining the system.

## 3. Problem
Payment screenshots are manually checked against Stripe. At scale, this is slow and vulnerable to duplicate submissions and forged screenshots.

## 4. Goals
- Receive screenshots from WhatsApp.
- Extract payment information reliably.
- Identify unclear submissions.
- Detect duplicate images.
- Detect duplicate transaction claims.
- Verify payment details against Stripe.
- Return an understandable verdict.
- Log decisions.
- Alert administrators on exceptions.

## 5. Non-goals for Phase 1
- production deployment;
- 50+ group rollout;
- production Stripe verification;
- production Google Sheets;
- Telegram;
- DigitalOcean;
- production Gemini;
- automated financial crediting.

## 6. Functional requirements

FR-001 WhatsApp ingestion
The system shall receive WhatsApp messages from a controlled test group.

FR-002 Image detection
The system shall identify image messages.

FR-003 Metadata
The system shall preserve message ID, group ID/name, sender identifier, received timestamp, and forwarded status where available.

FR-004 OCR
The system shall run Tesseract locally before cloud AI fallback.

FR-005 Structured extraction
The system shall extract email, amount, minutes/time, date, status, and customer name when available.

FR-006 AI fallback
When configured fallback criteria are met, the system shall send the image to the configured cloud AI provider.

FR-007 Provider abstraction
The business logic shall not depend directly on Groq or Gemini.

FR-008 Duplicate image detection
The system shall support SHA256 and perceptual hashing.

FR-009 Transaction duplicate detection
The system shall support a composite transaction key.

FR-010 Stripe verification
Later phase: verify candidate payment against Stripe.

FR-011 Logging
The system shall maintain auditable processing logs without storing secrets.

FR-012 Human-safe failure
Unclear or conflicting data shall never be automatically marked VALID.

## 7. Non-functional requirements

NFR-001 Security
Secrets must be externalized.

NFR-002 Privacy
Temporary images must be deleted after processing unless explicitly retained for approved testing.

NFR-003 Reliability
Recoverable WhatsApp and network errors should retry safely.

NFR-004 Observability
Every processing attempt shall have a correlation/processing ID.

NFR-005 Testability
OCR, extraction, hashing, verification, and verdict logic must be independently testable.

NFR-006 Maintainability
AI providers must be swappable through configuration.

## 8. Acceptance principle
Accuracy must be measured using a labeled test set, not claimed from a few successful examples.

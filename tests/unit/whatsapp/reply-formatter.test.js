const test = require('node:test');
const assert = require('node:assert/strict');
const { formatOcrReply } = require('../../../src/whatsapp/reply-formatter');

test('formats the OCR service fields response shape', () => {
  const reply = formatOcrReply({
    provider: 'tesseract',
    confidence: 0.85,
    fields: {
      email: 'customer@example.com',
      amount_cents: 2000,
      minutes: '19',
      payment_date: '2026-09-09',
      customer_name: 'Adam Craft',
      status: 'Completed',
    },
  }, 'wa-test');

  assert.match(reply, /Email: customer@example\.com/);
  assert.match(reply, /Amount: \$20\.00/);
  assert.match(reply, /Minutes: 19/);
  assert.match(reply, /Date: 2026-09-09/);
  assert.match(reply, /Name: Adam Craft/);
  assert.match(reply, /Status: Completed/);
});

test('uses the WhatsApp caption email as the lookup identity when OCR cannot see it', () => {
  const reply = formatOcrReply({
    provider: 'tesseract',
    confidence: 0.55,
    fields: { amount_cents: 2000, minutes: '13' },
  }, 'wa-caption-email', 'tommysimmons33@gmail.com');

  assert.match(reply, /Email: tommysimmons33@gmail\.com/);
  assert.doesNotMatch(reply, /Email: Not found/);
});

test('uses Stripe transaction details when verification returns the canonical charge', () => {
  const reply = formatOcrReply({
    provider: 'tesseract',
    confidence: 0.55,
    fields: { amount_cents: 1 },
    verification: {
      verdict: 'VALID',
      matched_transaction: {
        amount_cents: 2000,
        payment_date: '2026-09-09',
        payment_time: '00:13',
        customer_name: 'Tommy Simmons',
        status: 'Completed',
      },
    },
  }, 'wa-stripe-canonical', 'tommysimmons33@gmail.com');

  assert.match(reply, /Amount: \$20\.00/);
  assert.match(reply, /Date: 2026-09-09/);
  assert.match(reply, /Name: Tommy Simmons/);
  assert.match(reply, /Stripe Payment Time: 00:13/);
});

test('formats the server-side Stripe verification result', () => {
  const reply = formatOcrReply({
    provider: 'tesseract',
    confidence: 1,
    fields: { email: 'customer@example.com', amount_cents: 2000 },
    verification: {
      verdict: 'VALID',
      reason_code: 'EXACT_SINGLE_MATCH',
      stripe_charge_id: 'ch_test_123',
    },
  }, 'wa-stripe-test');

  assert.match(reply, /Stripe Verification: VALID/);
  assert.match(reply, /Verification Reason: EXACT_SINGLE_MATCH/);
  assert.match(reply, /Stripe Charge: ch_test_123/);
});

test('makes local OCR fallback visible without exposing provider details', () => {
  const reply = formatOcrReply({
    provider: 'tesseract',
    confidence: 0.42,
    fallback_reason: 'AI_PROVIDER_UNAVAILABLE',
    fields: { email: 'customer@example.com', amount_cents: 2000 },
  }, 'wa-fallback-test');

  assert.match(reply, /AI enhancement unavailable/);
  assert.match(reply, /local OCR/);
  assert.doesNotMatch(reply, /API key|429|Groq/);
});

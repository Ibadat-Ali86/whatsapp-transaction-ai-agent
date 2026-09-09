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

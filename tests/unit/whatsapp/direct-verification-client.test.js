const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStripeVerificationRequest,
  processImageDirectFallback,
} = require('../../../src/whatsapp/direct-verification-client');

test('builds bounded Stripe evidence from OCR and caption data', () => {
  const request = buildStripeVerificationRequest({
    ocrResult: {
      raw_text: 'AQ Digital LLC Today at 1:42 PM',
      fields: {
        email: 'ocr@example.com',
        amount_cents: 1000,
        customer_name: 'Jeff Reardon',
        payment_hour: 13,
        minutes: 42,
        transaction_id: 'bad id',
      },
    },
    job: {
      processing_id: 'wa-direct-1',
      caption_email: 'TiffanyAnn2695@gmail.com',
      received_at: '2026-09-22T18:42:00.000Z',
    },
    excludedStripeChargeIds: ['ch_claimed_1'],
  });

  assert.deepEqual(request, {
    processing_id: 'wa-direct-1',
    email: 'tiffanyann2695@gmail.com',
    email_candidates: ['tiffanyann2695@gmail.com', 'ocr@example.com'],
    transaction_id: null,
    description: null,
    customer_name: 'Jeff Reardon',
    amount_cents: 1000,
    payment_date: null,
    payment_month: null,
    payment_day: null,
    minutes: 42,
    payment_hour: 13,
    relative_today: true,
    received_at: '2026-09-22T18:42:00.000Z',
    currency: 'usd',
    payment_method_type: 'cashapp',
    excluded_stripe_charge_ids: ['ch_claimed_1'],
  });
});

test('runs direct OCR then authenticated Stripe verification', async () => {
  let request;
  const result = await processImageDirectFallback({
    imageBase64: 'synthetic',
    mimeType: 'image/png',
    processingId: 'wa-direct-2',
    messageId: 'message-2',
    groupId: 'group@g.us',
    senderJid: 'sender@s.whatsapp.net',
    captionEmail: 'customer@example.com',
    receivedAt: '2026-09-22T18:42:00.000Z',
    excludedStripeChargeIds: [],
  }, {
    config: {
      OCR_SERVICE_URL: 'http://ocr:8000',
      STRIPE_SERVICE_TOKEN: 'internal-token',
      STRIPE_DIRECT_TIMEOUT_MS: 130000,
    },
    processImageOCR: async params => {
      assert.equal(params.captionEmail, 'customer@example.com');
      return { provider: 'tesseract', fields: { amount_cents: 1000 } };
    },
    httpClient: {
      post: async (url, body, options) => {
        request = { url, body, options };
        return {
          status: 200,
          data: { status: 'MATCHED', verdict: 'VALID', stripe_charge_id: 'ch_valid' },
        };
      },
    },
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.verification.verdict, 'VALID');
  assert.equal(request.url, 'http://ocr:8000/api/v1/verification/stripe');
  assert.equal(request.options.headers['x-internal-service-token'], 'internal-token');
  assert.equal(request.body.email, 'customer@example.com');
  assert.equal(request.body.amount_cents, 1000);
});

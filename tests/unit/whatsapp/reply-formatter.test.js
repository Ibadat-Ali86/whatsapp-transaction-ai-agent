const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatOcrReply,
  formatDuplicateReply,
  formatVerificationFailureReply,
} = require('../../../src/whatsapp/reply-formatter');

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

  assert.match(reply, /Verified Stripe email: Not available/);
  assert.doesNotMatch(reply, /customer@example\.com/);
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

test('explains a captionless valid payment with Stripe proof and masks public identifiers', () => {
  const reply = formatOcrReply({
    provider: 'tesseract',
    confidence: 0.92,
    fields: { amount_cents: 677 },
    verification: {
      verdict: 'VALID',
      reason_code: 'EXACT_SINGLE_MATCH',
      candidate_count: 1,
      stripe_charge_id: 'ch_captionless_123456',
      matched_transaction: {
        stripe_charge_id: 'ch_captionless_123456',
        stripe_customer_id: 'cus_private_123456',
        amount_cents: 677,
        payment_date: '2026-09-20',
        payment_time: '01:43',
        customer_name: 'Van Pham',
        customer_email: 'vanpham@example.com',
        description: 'Cash App payment',
        status: 'Completed',
        payment_method_type: 'cashapp',
      },
    },
  }, 'wa-captionless-proof');

  assert.match(reply, /Caption email: Not provided/);
  assert.match(reply, /Verified Stripe email \(masked\): v\*\*\*m@example\.com/);
  assert.match(reply, /Description: Cash App payment/);
  assert.match(reply, /Stripe Payment Time: 01:43/);
  assert.match(reply, /Justification: No email was supplied in the caption/);
  assert.match(reply, /Stripe Charge: ch_…123456/);
  assert.doesNotMatch(reply, /vanpham@example\.com/);
  assert.doesNotMatch(reply, /cus_private_123456/);
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
  assert.match(reply, /Stripe Charge: ch_…st_123/);
  assert.match(reply, /Screenshot Status: ORIGINAL \/ VALID/);
});

test('formats duplicate and unclear screenshot statuses safely', () => {
  const duplicate = formatOcrReply({
    fields: { email: 'customer@example.com' },
    verification: {
      verdict: 'DUPLICATE',
      reason_code: 'DUPLICATE_STRIPE_TRANSACTION',
      duplicate_of_processing_id: 'wa-original',
    },
  }, 'wa-duplicate', 'customer@example.com');
  assert.match(duplicate, /Screenshot Status: DUPLICATE/);
  assert.match(duplicate, /Original Processing ID: wa-original/);
  assert.match(duplicate, /Stripe Verification: DUPLICATE/);

  const unclear = formatOcrReply({
    fields: { email: 'customer@example.com' },
    verification: { verdict: 'UNCLEAR', reason_code: 'NO_EXACT_MATCH' },
  }, 'wa-unclear', 'customer@example.com');
  assert.match(unclear, /Screenshot Status: UNCLEAR \/ NOT CONFIRMED/);
  assert.match(unclear, /❌ Stripe Verification: UNCLEAR/);
  assert.doesNotMatch(unclear, /⚠️ Screenshot Status/);
});

test('formats an ambiguous payment as review-required rather than fake', () => {
  const reply = formatVerificationFailureReply({
    fields: { payment_date: '2026-09-20' },
    verification: {
      verdict: 'UNCLEAR',
      reason_code: 'MULTIPLE_EXACT_MATCHES',
      candidate_count: 2,
      candidate_transactions: [
        {
          stripe_charge_id: 'ch_recent',
          stripe_customer_id: 'cus_customer',
          amount_cents: 1000,
          currency: 'usd',
          payment_date: '2026-09-20',
          payment_time: '06:45',
          customer_name: 'Jenny Waters',
          customer_email: 'jenny@example.com',
          description: 'Recent payment',
          status: 'Completed',
          payment_method_type: 'cashapp',
        },
        {
          stripe_charge_id: 'ch_previous',
          amount_cents: 1000,
          payment_date: '2026-09-19',
          payment_time: '22:10',
          description: 'Previous payment',
          status: 'Completed',
          payment_method_type: 'cashapp',
        },
      ],
    },
  }, 'wa-unconfirmed');

  assert.match(reply, /⚠️ \*Payment Requires Review\*/);
  assert.match(reply, /multiple eligible payments/);
  assert.match(reply, /Verification reason: MULTIPLE_EXACT_MATCHES/);
  assert.match(reply, /Stripe candidates reviewed: 2/);
  assert.match(reply, /Newest Stripe Candidate \(review context\)/);
  assert.match(reply, /Only the newest of 2 eligible candidate records is shown/);
  assert.match(reply, /Candidate 1 — Most Recent/);
  assert.match(reply, /ch_…recent/);
  assert.match(reply, /Recent payment/);
  assert.doesNotMatch(reply, /Candidate 2 — Match 2/);
  assert.doesNotMatch(reply, /ch_…evious/);
  assert.match(reply, /No candidate was approved or claimed automatically/);
  assert.match(reply, /not a fraud determination/);
});

test('explains why a visually matching receipt with a different Stripe charge is blocked', () => {
  const reply = formatVerificationFailureReply({
    verification: {
      verdict: 'UNCLEAR',
      reason_code: 'IMAGE_MATCH_DIFFERENT_STRIPE_CHARGE',
      candidate_count: 1,
      image_conflict_original_processing_id: 'wa-original',
      image_conflict_original_stripe_charge_id: 'ch-original',
      stripe_charge_id: 'ch-current',
    },
  }, 'wa-conflict');

  assert.match(reply, /previously approved receipt image matched/);
  assert.match(reply, /Prior matching screenshot: wa-original/);
  assert.match(reply, /Prior Stripe charge: ch-original/);
  assert.match(reply, /Current Stripe charge: ch-current/);
  assert.match(reply, /Automatic approval was blocked/);
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

test('formats a concise duplicate justification with group scope', () => {
  const reply = formatDuplicateReply({
    verification: {
      reason_code: 'DUPLICATE_IMAGE_SHA256',
      duplicate_of_processing_id: 'wa-original',
    },
  }, 'wa-duplicate', { groupScope: 'another_group' });

  assert.match(reply, /Duplicate Screenshot/);
  assert.match(reply, /another group/);
  assert.match(reply, /DUPLICATE_IMAGE_SHA256/);
  assert.match(reply, /Original Processing ID: wa-original/);
  assert.doesNotMatch(reply, /Stripe Verification/);
});

test('names the original group for a same-group duplicate', () => {
  const reply = formatDuplicateReply({
    verification: {
      reason_code: 'DUPLICATE_IMAGE_SHA256',
      duplicate_of_processing_id: 'wa-original',
    },
  }, 'wa-duplicate', { groupScope: 'same_group', originalGroupName: 'Operations Review' });

  assert.match(reply, /already processed in the same group "Operations Review"/);
});

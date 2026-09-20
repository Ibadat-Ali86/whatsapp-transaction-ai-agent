const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDuplicateStore, hammingDistance } = require('../../../src/whatsapp/duplicate-store');

function temporaryPath() {
  return path.join(os.tmpdir(), `wa-duplicate-store-${process.pid}-${Math.random()}.json`);
}

test('claims exact image hashes and persists records across store instances', () => {
  const filePath = temporaryPath();
  const sha256 = 'a'.repeat(64);
  const first = createDuplicateStore({ filePath });
  const claim = first.claimImage({ sha256, processingId: 'wa-first', groupIdHash: 'group-a', groupName: 'Alpha Group' });
  assert.equal(claim.duplicate, false);
  first.registerImageEvidence({
    sha256,
    phash: '0123456789abcdef',
    stripeChargeId: 'ch_first_payment',
    verificationVerdict: 'VALID',
    processingId: 'wa-first',
  });

  const second = createDuplicateStore({ filePath });
  const duplicate = second.claimImage({ sha256, processingId: 'wa-second', groupIdHash: 'group-b' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.matchType, 'SHA256');
  assert.equal(duplicate.record.processing_id, 'wa-first');
  assert.equal(duplicate.record.group_name, 'Alpha Group');
  assert.deepEqual(duplicate.confirmed_stripe_charge_ids, ['ch_first_payment']);
  fs.unlinkSync(filePath);
});

test('recognizes a recompressed image by pHash only with the same Stripe charge', () => {
  const store = createDuplicateStore({ filePath: temporaryPath(), phashMaxDistance: 6 });
  const firstSha = 'b'.repeat(64);
  const secondSha = 'c'.repeat(64);
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a', groupName: 'Alpha Group' });
  store.registerImageEvidence({
    sha256: firstSha,
    phash: '0000000000000000',
    captionEmail: 'customer@example.com',
    amountCents: 2000,
    stripeChargeId: 'ch_same_payment',
    paymentDate: '2026-09-18',
    paymentHour: 20,
    minutes: 13,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-b', groupName: 'Beta Group' });
  const duplicate = store.registerImageEvidence({
    sha256: secondSha,
    phash: '0000000000000001',
    captionEmail: 'customer@example.com',
    amountCents: 2000,
    stripeChargeId: 'ch_same_payment',
    paymentDate: '2026-09-18',
    paymentHour: 20,
    minutes: 13,
    processingId: 'wa-second',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.matchType, 'PHASH');
  assert.equal(duplicate.distance, 1);
  assert.equal(hammingDistance('0000000000000000', '0000000000000001'), 1);
});

test('does not classify visually similar receipts for different Stripe charges', () => {
  const store = createDuplicateStore({ filePath: temporaryPath(), phashMaxDistance: 6 });
  const firstSha = '1'.repeat(64);
  const secondSha = '2'.repeat(64);
  const sharedEvidence = {
    captionEmail: 'customer@example.com',
    amountCents: 2000,
    paymentDate: '2026-09-18',
    paymentHour: 20,
    minutes: 13,
  };
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    phash: '0000000000000000',
    stripeChargeId: 'ch_first_payment',
    ...sharedEvidence,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-a' });
  const result = store.registerImageEvidence({
    sha256: secondSha,
    phash: '0000000000000001',
    stripeChargeId: 'ch_second_payment',
    ...sharedEvidence,
    processingId: 'wa-second',
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.conflict, true);
});

test('returns a conflict for visually similar receipts with a different Stripe charge', () => {
  const store = createDuplicateStore({ filePath: temporaryPath(), phashMaxDistance: 6 });
  const firstSha = '3'.repeat(64);
  const secondSha = '4'.repeat(64);
  const sharedEvidence = {
    captionEmail: 'customer@example.com',
    amountCents: 2000,
    paymentDate: '2026-09-18',
    paymentHour: 20,
    minutes: 13,
  };
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    phash: '0000000000000000',
    stripeChargeId: 'ch_first_payment',
    verificationVerdict: 'VALID',
    ...sharedEvidence,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-a' });
  const result = store.registerImageEvidence({
    sha256: secondSha,
    phash: '0000000000000001',
    stripeChargeId: 'ch_second_payment',
    verificationVerdict: 'VALID',
    ...sharedEvidence,
    processingId: 'wa-second',
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.conflict, true);
  assert.equal(result.matchType, 'PHASH_DIFFERENT_STRIPE_CHARGE');
  assert.equal(result.record.stripe_charge_id, 'ch_first_payment');
});

test('does not classify same-email same-amount payments with different receipt times as pHash duplicates', () => {
  const store = createDuplicateStore({ filePath: temporaryPath(), phashMaxDistance: 6 });
  const firstSha = 'd'.repeat(64);
  const secondSha = 'e'.repeat(64);
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    phash: '0000000000000000',
    captionEmail: 'customer@example.com',
    amountCents: 500,
    paymentDate: '2026-09-18',
    paymentHour: 20,
    minutes: 13,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-a' });
  const result = store.registerImageEvidence({
    sha256: secondSha,
    phash: '0000000000000001',
    captionEmail: 'customer@example.com',
    amountCents: 500,
    paymentDate: '2026-09-18',
    paymentHour: 20,
    minutes: 14,
    processingId: 'wa-second',
  });
  assert.equal(result.duplicate, false);
});

test('requires payment-specific evidence before using pHash', () => {
  const store = createDuplicateStore({ filePath: temporaryPath(), phashMaxDistance: 6 });
  const firstSha = 'f'.repeat(64);
  const secondSha = '0'.repeat(64);
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    phash: '0000000000000000',
    captionEmail: 'customer@example.com',
    amountCents: 500,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-a' });
  const result = store.registerImageEvidence({
    sha256: secondSha,
    phash: '0000000000000001',
    captionEmail: 'customer@example.com',
    amountCents: 500,
    processingId: 'wa-second',
  });
  assert.equal(result.duplicate, false);
});

test('detects recompressed repeats from a payment identifier when Stripe has not resolved either attempt', () => {
  const store = createDuplicateStore({ filePath: temporaryPath(), phashMaxDistance: 6 });
  const firstSha = '5'.repeat(64);
  const secondSha = '6'.repeat(64);
  const sharedEvidence = {
    captionEmail: 'customer@example.com',
    amountCents: 500,
    transactionId: 'TJ2WHT1Z0',
    paymentDate: '2026-09-18',
    paymentHour: 22,
    minutes: 56,
  };
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    phash: '0000000000000000',
    verificationVerdict: 'UNCLEAR',
    ...sharedEvidence,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-b' });
  const result = store.registerImageEvidence({
    sha256: secondSha,
    phash: '0000000000000001',
    verificationVerdict: 'UNCLEAR',
    ...sharedEvidence,
    processingId: 'wa-second',
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.matchType, 'TRANSACTION_EVIDENCE');
  assert.equal(result.record.processing_id, 'wa-first');
  assert.equal(result.proof.transaction_id, 'tj2wht1z0');
});

test('detects a repeated payment evidence fingerprint without relying on pHash', () => {
  const store = createDuplicateStore({ filePath: temporaryPath() });
  const firstSha = '7'.repeat(64);
  const secondSha = '8'.repeat(64);
  const sharedEvidence = {
    amountCents: 500,
    transactionId: 'TJ2WHT1Z0',
    paymentDate: '2026-09-18',
    paymentHour: 22,
    minutes: 56,
  };
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    verificationVerdict: 'UNCLEAR',
    ...sharedEvidence,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-b' });
  const result = store.registerImageEvidence({
    sha256: secondSha,
    verificationVerdict: 'UNCLEAR',
    ...sharedEvidence,
    processingId: 'wa-second',
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.matchType, 'TRANSACTION_EVIDENCE');
  assert.equal(result.record.processing_id, 'wa-first');
});

test('allows the first later Stripe-resolved attempt after an unresolved repeat', () => {
  const store = createDuplicateStore({ filePath: temporaryPath() });
  const firstSha = '9'.repeat(64);
  const secondSha = 'a'.repeat(64);
  const sharedEvidence = {
    amountCents: 500,
    transactionId: 'TJ2WHT1Z0',
    paymentDate: '2026-09-18',
    paymentHour: 22,
    minutes: 56,
  };
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    verificationVerdict: 'UNCLEAR',
    ...sharedEvidence,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-b' });
  const result = store.registerImageEvidence({
    sha256: secondSha,
    stripeChargeId: 'ch-first-success',
    verificationVerdict: 'VALID',
    ...sharedEvidence,
    processingId: 'wa-second',
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.conflict, undefined);
});

test('uses customer, amount, date, and time plus pHash when the identifier is not OCR-readable', () => {
  const store = createDuplicateStore({ filePath: temporaryPath(), phashMaxDistance: 6 });
  const firstSha = 'b'.repeat(64);
  const secondSha = 'c'.repeat(64);
  const sharedEvidence = {
    amountCents: 500,
    customerName: 'Mckayla Fifer',
    paymentDate: '2026-09-18',
    paymentHour: 22,
    minutes: 56,
  };
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    phash: '0000000000000000',
    verificationVerdict: 'UNCLEAR',
    ...sharedEvidence,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-b' });
  const result = store.registerImageEvidence({
    sha256: secondSha,
    phash: '0000000000000001',
    verificationVerdict: 'UNCLEAR',
    ...sharedEvidence,
    processingId: 'wa-second',
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.matchType, 'PHASH_RECEIPT_EVIDENCE');
});

test('returns recent claimed Stripe charge IDs for multi-match recovery', () => {
  const store = createDuplicateStore({ filePath: temporaryPath() });
  store.claimTransaction('stripe:ch_old', { processingId: 'wa-old', groupIdHash: 'group-a' });
  store.claimTransaction('stripe:ch_new', { processingId: 'wa-new', groupIdHash: 'group-a' });
  assert.deepEqual(new Set(store.getClaimedTransactionIds()), new Set(['ch_new', 'ch_old']));
});

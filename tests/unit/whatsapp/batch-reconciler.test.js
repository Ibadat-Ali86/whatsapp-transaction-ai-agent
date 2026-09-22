const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileCandidateBatch } = require('../../../src/verification/batch-reconciler');

function result(processingId, fields, candidates) {
  return {
    processingId,
    job: { caption_email: 'customer@example.com' },
    result: {
      fields,
      verification: {
        verdict: 'UNCLEAR',
        reason_code: 'MULTIPLE_EXACT_MATCHES',
        candidate_transactions: candidates,
      },
    },
  };
}

function candidate(id, time) {
  return {
    stripe_charge_id: id,
    amount_cents: 1000,
    customer_email: 'customer@example.com',
    customer_name: 'Jamie Example',
    payment_date: '2026-09-21',
    payment_time: time,
    status: 'Completed',
    payment_method_type: 'cashapp',
  };
}

test('assigns a unique one-to-one mapping for a batch with distinct receipt times', () => {
  const assignments = reconcileCandidateBatch([
    result('one', {
      amount_cents: 1000,
      customer_name: 'Jamie Example',
      payment_date: '2026-09-21',
      payment_hour: 10,
      minutes: 5,
    }, [candidate('ch-one', '10:05'), candidate('ch-two', '10:30')]),
    result('two', {
      amount_cents: 1000,
      customer_name: 'Jamie Example',
      payment_date: '2026-09-21',
      payment_hour: 10,
      minutes: 30,
    }, [candidate('ch-one', '10:05'), candidate('ch-two', '10:30')]),
  ]);

  assert.equal(assignments.get('one').stripe_charge_id, 'ch-one');
  assert.equal(assignments.get('two').stripe_charge_id, 'ch-two');
});

test('keeps an equal-evidence batch unresolved instead of guessing', () => {
  const sameCandidates = [candidate('ch-one', '10:05'), candidate('ch-two', '10:05')];
  const assignments = reconcileCandidateBatch([
    result('one', { amount_cents: 1000 }, sameCandidates),
    result('two', { amount_cents: 1000 }, sameCandidates),
  ]);

  assert.equal(assignments.size, 0);
});

test('does not assign when the winner differs only by the amount baseline', () => {
  const assignments = reconcileCandidateBatch([
    result('one', { amount_cents: 1000 }, [candidate('ch-one', null), candidate('ch-two', null)]),
  ]);

  assert.equal(assignments.size, 0);
});

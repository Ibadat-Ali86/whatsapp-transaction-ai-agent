const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProcessingQueue, QueueFullError } = require('../../../src/whatsapp/processing-queue');

function temporaryPath() {
  return path.join(os.tmpdir(), `wa-processing-queue-${process.pid}-${Math.random()}.json`);
}

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

test('processes one job at a time and preserves fair group ordering', async () => {
  const events = [];
  let active = 0;
  let peak = 0;
  const queue = createProcessingQueue({
    concurrency: 1,
    cooldownMs: 0,
    worker: async job => {
      active += 1;
      peak = Math.max(peak, active);
      events.push(`start:${job.group_id}:${job.processing_id}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push(`end:${job.group_id}:${job.processing_id}`);
      active -= 1;
      return { status: 'COMPLETED' };
    },
    logger: logger(),
  });

  const jobs = [
    { processing_id: 'a1', idempotency_key: 'a1', group_id: 'group-a' },
    { processing_id: 'a2', idempotency_key: 'a2', group_id: 'group-a' },
    { processing_id: 'b1', idempotency_key: 'b1', group_id: 'group-b' },
    { processing_id: 'c1', idempotency_key: 'c1', group_id: 'group-c' },
  ];
  await Promise.all(jobs.map(job => queue.enqueue(job)));

  assert.equal(peak, 1);
  assert.deepEqual(events, [
    'start:group-a:a1', 'end:group-a:a1',
    'start:group-b:b1', 'end:group-b:b1',
    'start:group-c:c1', 'end:group-c:c1',
    'start:group-a:a2', 'end:group-a:a2',
  ]);
  queue.stop();
});

test('retries retryable jobs with bounded attempts and persists final state', async () => {
  const filePath = temporaryPath();
  let attempts = 0;
  const queue = createProcessingQueue({
    filePath,
    maxAttempts: 3,
    backoffBaseMs: 1,
    backoffMaxMs: 2,
    cooldownMs: 0,
    worker: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('temporary outage');
        error.retryable = true;
        throw error;
      }
      return { status: 'COMPLETED', verdict: 'VALID' };
    },
    logger: logger(),
  });

  const result = await queue.enqueue({ processing_id: 'retry-1', idempotency_key: 'retry-1', group_id: 'group-a' });
  assert.equal(result.verdict, 'VALID');
  assert.equal(attempts, 3);
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(persisted.jobs['retry-1'].status, 'COMPLETED');
  assert.equal(persisted.jobs['retry-1'].attempts, 3);
  queue.stop();
  fs.unlinkSync(filePath);
});

test('keeps retryable dependency failures queued beyond the normal attempt limit', async () => {
  let attempts = 0;
  let deadLetterCalled = false;
  const queue = createProcessingQueue({
    maxAttempts: 1,
    deferRetryableErrors: true,
    backoffBaseMs: 1,
    backoffMaxMs: 1,
    cooldownMs: 0,
    worker: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('n8n timeout');
        error.retryable = true;
        throw error;
      }
      return { status: 'COMPLETED', verdict: 'VALID' };
    },
    onDeadLetter: async () => { deadLetterCalled = true; },
    logger: logger(),
  });

  const result = await queue.enqueue({ processing_id: 'deferred-1', idempotency_key: 'deferred-1', group_id: 'group-a' });
  assert.equal(result.verdict, 'VALID');
  assert.equal(attempts, 2);
  assert.equal(deadLetterCalled, false);
  queue.stop();
});

test('moves permanent failures to dead letter and does not retry them', async () => {
  let attempts = 0;
  let deadLetter;
  const queue = createProcessingQueue({
    maxAttempts: 4,
    cooldownMs: 0,
    worker: async () => {
      attempts += 1;
      throw new Error('invalid payload');
    },
    onDeadLetter: async (job, error) => { deadLetter = { job, error }; },
    logger: logger(),
  });

  const result = await queue.enqueue({ processing_id: 'bad-1', idempotency_key: 'bad-1', group_id: 'group-a' });
  assert.equal(result.status, 'DEAD_LETTER');
  assert.equal(attempts, 1);
  assert.equal(deadLetter.job.processing_id, 'bad-1');
  assert.equal(deadLetter.error.message, 'invalid payload');
  queue.stop();
});

test('rejects new work when the pending queue is full', async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const queue = createProcessingQueue({
    maxPending: 1,
    cooldownMs: 0,
    worker: async () => blocker,
    logger: logger(),
  });

  const first = queue.enqueue({ processing_id: 'full-1', idempotency_key: 'full-1', group_id: 'group-a' });
  assert.throws(() => queue.enqueue({ processing_id: 'full-2', idempotency_key: 'full-2', group_id: 'group-b' }), QueueFullError);
  release();
  await first;
  queue.stop();
});

test('recovers a processing job from disk after a restart', async () => {
  const filePath = temporaryPath();
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    sequence: 1,
    lastGroupId: null,
    groupOrder: ['group-a'],
    jobs: {
      'recovered-1': {
        job_id: 'recovered-1',
        processing_id: 'recovered-1',
        idempotency_key: 'recovered-1',
        group_id: 'group-a',
        status: 'PROCESSING',
        attempts: 1,
        sequence: 1,
        available_at: Date.now(),
        queued_at: Date.now(),
      },
    },
  }));
  let processed = 0;
  const queue = createProcessingQueue({
    filePath,
    cooldownMs: 0,
    worker: async () => {
      processed += 1;
      return { status: 'COMPLETED' };
    },
    logger: logger(),
  });

  queue.start();
  const result = await queue.enqueue({ processing_id: 'recovered-1', idempotency_key: 'recovered-1', group_id: 'group-a' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(processed, 1);
  queue.stop();
  fs.unlinkSync(filePath);
});

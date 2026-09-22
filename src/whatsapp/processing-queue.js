const fs = require('fs');
const path = require('path');

class ProcessingQueueError extends Error {
  constructor(message, code = 'PROCESSING_QUEUE_ERROR') {
    super(message);
    this.name = 'ProcessingQueueError';
    this.code = code;
    this.retryable = false;
  }
}

class QueueFullError extends ProcessingQueueError {
  constructor(message = 'Processing queue is full') {
    super(message, 'PROCESSING_QUEUE_FULL');
    this.name = 'QueueFullError';
  }
}

function safeJsonValue(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function reviveJsonValue(_key, value) {
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  if (value && value.__type === 'Uint8Array' && Array.isArray(value.data)) {
    return Uint8Array.from(value.data);
  }
  return value;
}

function createProcessingQueue({
  filePath = null,
  concurrency = 1,
  maxPending = 200,
  maxAttempts = 4,
  deferRetryableErrors = false,
  backoffBaseMs = 5000,
  backoffMaxMs = 300000,
  cooldownMs = 250,
  retentionMs = 7 * 24 * 60 * 60 * 1000,
  maxRecords = 5000,
  worker,
  onDeadLetter,
  logger = { debug() {}, info() {}, warn() {}, error() {} },
} = {}) {
  if (typeof worker !== 'function') throw new TypeError('A queue worker is required');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('Queue concurrency must be a positive integer');
  if (!Number.isInteger(maxPending) || maxPending < 1) throw new TypeError('Queue maxPending must be a positive integer');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('Queue maxAttempts must be a positive integer');

  const state = {
    version: 1,
    sequence: 0,
    lastGroupId: null,
    groupOrder: [],
    jobs: {},
  };
  const waiters = new Map();
  let active = 0;
  let stopped = false;
  let pumpScheduled = false;
  let timer = null;

  const pruneFinalized = () => {
    const cutoff = Date.now() - retentionMs;
    const finalized = Object.entries(state.jobs)
      .filter(([, job]) => job.status === 'COMPLETED' || job.status === 'DEAD_LETTER')
      .sort(([, left], [, right]) => (left.completed_at || left.dead_lettered_at || 0) - (right.completed_at || right.dead_lettered_at || 0));
    for (const [jobId, job] of finalized) {
      const finishedAt = job.completed_at || job.dead_lettered_at || 0;
      if (finishedAt < cutoff) delete state.jobs[jobId];
    }
    const remainingFinalized = Object.entries(state.jobs)
      .filter(([, job]) => job.status === 'COMPLETED' || job.status === 'DEAD_LETTER')
      .sort(([, left], [, right]) => (left.completed_at || left.dead_lettered_at || 0) - (right.completed_at || right.dead_lettered_at || 0));
    if (remainingFinalized.length > maxRecords) {
      for (const [jobId] of remainingFinalized.slice(0, remainingFinalized.length - maxRecords)) delete state.jobs[jobId];
    }
  };

  const persist = () => {
    if (!filePath) return;
    pruneFinalized();
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, safeJsonValue), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  };

  const isRecoverableN8nDeadLetter = job => {
    const error = job?.last_error;
    if (job?.status !== 'DEAD_LETTER' || error?.name !== 'N8nServiceError') return false;
    return error.code === 'ECONNABORTED'
      || error.code === 'ETIMEDOUT'
      || error.code === 'ECONNRESET'
      || /n8n webhook request failed \(network\)/i.test(error.message || '');
  };

  const load = () => {
    if (!filePath) return;
    try {
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'), reviveJsonValue);
      if (!loaded || typeof loaded !== 'object') return;
      if (loaded.version !== 1 || !loaded.jobs || typeof loaded.jobs !== 'object') {
        throw new ProcessingQueueError('Unsupported processing queue format', 'PROCESSING_QUEUE_FORMAT');
      }
      state.sequence = Number.isInteger(loaded.sequence) ? loaded.sequence : 0;
      state.lastGroupId = typeof loaded.lastGroupId === 'string' ? loaded.lastGroupId : null;
      state.groupOrder = Array.isArray(loaded.groupOrder) ? loaded.groupOrder.filter(groupId => typeof groupId === 'string') : [];
      state.jobs = loaded.jobs;

      let recovered = false;
      for (const job of Object.values(state.jobs)) {
        if (job.status === 'PROCESSING') {
          job.status = 'QUEUED';
          job.recovered_at = Date.now();
          recovered = true;
        }
        // Older releases converted exhausted n8n transport retries into
        // DEAD_LETTER. Recover only that known transient failure class on
        // startup; authentication and malformed-request dead letters remain
        // terminal instead of creating an infinite loop.
        if (isRecoverableN8nDeadLetter(job)) {
          job.status = 'QUEUED';
          job.available_at = Date.now();
          job.recovered_from_dead_letter_at = Date.now();
          delete job.dead_lettered_at;
          recovered = true;
          logger.warn({ processingId: job.processing_id }, 'Recovered transient n8n dead letter for retry');
        }
      }
      if (recovered) persist();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };

  const pendingCount = () => Object.values(state.jobs)
    .filter(job => job.status === 'QUEUED' || job.status === 'PROCESSING').length;

  const pendingCountForGroup = groupId => Object.values(state.jobs)
    .filter(job => (
      (job.status === 'QUEUED' || job.status === 'PROCESSING')
      && job.group_id === groupId
    )).length;

  const waitFor = jobId => new Promise((resolve, reject) => {
    const job = state.jobs[jobId];
    if (job?.status === 'COMPLETED') {
      resolve(job.result || { status: job.status, processing_id: job.processing_id });
      return;
    }
    if (job?.status === 'DEAD_LETTER') {
      resolve({ status: job.status, processing_id: job.processing_id });
      return;
    }
    const entries = waiters.get(jobId) || [];
    entries.push({ resolve, reject });
    waiters.set(jobId, entries);
  });

  const settle = (jobId, value, error = null) => {
    const entries = waiters.get(jobId) || [];
    waiters.delete(jobId);
    for (const entry of entries) {
      if (error) entry.reject(error);
      else entry.resolve(value);
    }
  };

  const eligibleGroups = () => {
    const groups = new Map();
    for (const job of Object.values(state.jobs)) {
      if (job.status !== 'QUEUED' || (job.available_at || 0) > Date.now()) continue;
      const groupId = job.group_id || '__unknown__';
      const current = groups.get(groupId);
      if (!current || job.sequence < current.sequence) groups.set(groupId, job);
    }
    return [...groups.entries()].sort(([, left], [, right]) => left.sequence - right.sequence);
  };

  const pickNext = () => {
    const activeGroups = new Set(Object.values(state.jobs)
      .filter(job => job.status === 'PROCESSING')
      .map(job => job.group_id || '__unknown__'));
    const groups = eligibleGroups().filter(([groupId]) => !activeGroups.has(groupId));
    if (!groups.length) return null;

    let selected = groups[0];
    if (state.lastGroupId && state.groupOrder.length) {
      const lastOrderIndex = state.groupOrder.indexOf(state.lastGroupId);
      if (lastOrderIndex >= 0) {
        const rotated = [...groups].sort(([left], [right]) => {
          const leftDistance = (state.groupOrder.indexOf(left) - lastOrderIndex + state.groupOrder.length) % state.groupOrder.length;
          const rightDistance = (state.groupOrder.indexOf(right) - lastOrderIndex + state.groupOrder.length) % state.groupOrder.length;
          return leftDistance - rightDistance;
        });
        selected = rotated.find(([, job]) => job.group_id !== state.lastGroupId) || rotated[0];
      }
    }
    state.lastGroupId = selected[0];
    return selected[1];
  };

  const nextAvailableAt = () => Object.values(state.jobs)
    .filter(job => job.status === 'QUEUED')
    .reduce((earliest, job) => Math.min(earliest, job.available_at || Date.now()), Infinity);

  const schedulePump = delayMs => {
    if (stopped || pumpScheduled) return;
    pumpScheduled = true;
    timer = setTimeout(() => {
      pumpScheduled = false;
      timer = null;
      void pump();
    }, Math.max(0, delayMs));
  };

  const runJob = async job => {
    try {
      const result = await worker(job);
      job.status = 'COMPLETED';
      job.completed_at = Date.now();
      job.result = result && typeof result === 'object' ? result : { status: 'COMPLETED' };
      persist();
      settle(job.job_id, job.result);
      logger.info({ processingId: job.processing_id, groupId: job.group_id }, 'Processing queue job completed');
    } catch (error) {
      const attempt = job.attempts || 1;
      job.last_error = {
        name: error?.name || 'Error',
        code: error?.code || null,
        message: error?.message || 'Processing failed',
        at: Date.now(),
      };
      // A dependency outage is not a payment decision. When enabled, keep
      // retryable jobs durably queued beyond maxAttempts instead of converting
      // a temporary n8n/WhatsApp/OCR failure into a manual-review dead letter.
      const deferRetryable = deferRetryableErrors && error?.retryable === true;
      const canRetry = deferRetryable || (error?.retryable === true && attempt < maxAttempts);
      if (canRetry) {
        const exponential = Math.min(backoffMaxMs, backoffBaseMs * (2 ** Math.min(attempt - 1, 20)));
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.25)));
        job.status = 'QUEUED';
        job.available_at = Date.now() + exponential + jitter;
        persist();
        logger.warn({
          processingId: job.processing_id,
          attempt,
          retryAt: job.available_at,
          deferredUntilRecovered: deferRetryable,
          errorType: error?.name || 'Error',
          errorCode: error?.code || null,
        }, deferRetryable
          ? 'Processing queue job deferred until dependency recovers'
          : 'Processing queue job scheduled for retry');
      } else {
        job.status = 'DEAD_LETTER';
        job.dead_lettered_at = Date.now();
        persist();
        logger.error({ processingId: job.processing_id, attempts: attempt, err: error }, 'Processing queue job moved to dead letter');
        if (typeof onDeadLetter === 'function') {
          try {
            await onDeadLetter(job, error);
          } catch (notificationError) {
            logger.error({ processingId: job.processing_id, err: notificationError }, 'Failed to notify about dead-lettered job');
          }
        }
        settle(job.job_id, { status: job.status, processing_id: job.processing_id });
      }
    } finally {
      active -= 1;
      schedulePump(cooldownMs);
    }
  };

  async function pump() {
    if (stopped) return;
    while (!stopped && active < concurrency) {
      const job = pickNext();
      if (!job) {
        const nextAt = nextAvailableAt();
        if (Number.isFinite(nextAt)) schedulePump(Math.max(cooldownMs, nextAt - Date.now()));
        return;
      }
      job.status = 'PROCESSING';
      job.attempts = (job.attempts || 0) + 1;
      job.started_at = job.started_at || Date.now();
      job.last_started_at = Date.now();
      persist();
      active += 1;
      void runJob(job);
    }
  }

  load();

  return {
    enqueue(job) {
      if (!job || typeof job !== 'object') throw new TypeError('Queue job must be an object');
      if (!job.processing_id || !job.idempotency_key) throw new TypeError('Queue job requires processing_id and idempotency_key');
      const jobId = String(job.idempotency_key);
      const existing = state.jobs[jobId];
      if (existing) return waitFor(jobId);
      if (pendingCount() >= maxPending) throw new QueueFullError();

      state.sequence += 1;
      const groupId = job.group_id || '__unknown__';
      if (!state.groupOrder.includes(groupId)) state.groupOrder.push(groupId);
      state.jobs[jobId] = {
        ...job,
        job_id: jobId,
        sequence: state.sequence,
        status: 'QUEUED',
        attempts: 0,
        available_at: Date.now(),
        queued_at: Date.now(),
      };
      persist();
      const result = waitFor(jobId);
      void pump();
      return result;
    },
    pendingCountForGroup,
    start() {
      stopped = false;
      void pump();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pumpScheduled = false;
    },
    snapshot() {
      return Object.values(state.jobs).map(job => ({
        processing_id: job.processing_id,
        group_id: job.group_id,
        status: job.status,
        attempts: job.attempts,
        queued_at: job.queued_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
      }));
    },
    get pendingCount() {
      return pendingCount();
    },
  };
}

module.exports = { createProcessingQueue, ProcessingQueueError, QueueFullError };

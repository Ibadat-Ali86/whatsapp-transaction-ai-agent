const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function emailHash(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 16);
}

function hammingDistance(left, right) {
  if (!/^[0-9a-f]{16}$/i.test(left || '') || !/^[0-9a-f]{16}$/i.test(right || '')) return null;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value > 0n) {
    value &= value - 1n;
    distance += 1;
  }
  return distance;
}

function createDuplicateStore({
  filePath = 'data/duplicate-store.json',
  ttlMs = 90 * 24 * 60 * 60 * 1000,
  maxEntries = 100_000,
  phashMaxDistance = 6,
} = {}) {
  const state = {
    version: 1,
    images: {},
    transactions: {},
  };

  const load = () => {
    try {
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (loaded && typeof loaded === 'object') {
        state.images = loaded.images && typeof loaded.images === 'object' ? loaded.images : {};
        state.transactions = loaded.transactions && typeof loaded.transactions === 'object' ? loaded.transactions : {};
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };

  const persist = () => {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  };

  const prune = () => {
    const cutoff = Date.now() - ttlMs;
    let changed = false;
    for (const collection of [state.images, state.transactions]) {
      for (const [key, record] of Object.entries(collection)) {
        if (!Number.isInteger(record?.first_seen_at) || record.first_seen_at < cutoff) {
          delete collection[key];
          changed = true;
        }
      }
    }
    if (changed) persist();
  };

  const trim = collection => {
    const entries = Object.entries(collection);
    if (entries.length <= maxEntries) return false;
    entries.sort(([, left], [, right]) => (left.first_seen_at || 0) - (right.first_seen_at || 0));
    for (const [key] of entries.slice(0, entries.length - maxEntries)) delete collection[key];
    return true;
  };

  load();

  return {
    claimImage({ sha256, processingId, groupIdHash, captionEmail, amountCents }) {
      if (!/^[0-9a-f]{64}$/i.test(sha256 || '')) throw new Error('Invalid image SHA-256');
      prune();
      const existing = state.images[sha256];
      if (existing) return { duplicate: true, matchType: 'SHA256', record: existing };

      const record = {
        processing_id: processingId,
        group_id_hash: groupIdHash,
        first_seen_at: Date.now(),
        email_hash: captionEmail ? emailHash(captionEmail) : null,
        amount_cents: Number.isInteger(amountCents) ? amountCents : null,
        status: 'PROCESSING',
      };
      state.images[sha256] = record;
      trim(state.images);
      persist();
      return { duplicate: false, record };
    },

    registerImageEvidence({ sha256, phash, captionEmail, amountCents, processingId }) {
      prune();
      const current = state.images[sha256];
      if (current) {
        current.phash = typeof phash === 'string' ? phash.toLowerCase() : null;
        current.email_hash = captionEmail ? emailHash(captionEmail) : current.email_hash;
        current.amount_cents = Number.isInteger(amountCents) ? amountCents : current.amount_cents;
        current.status = 'COMPLETED';
      }

      if (typeof phash === 'string' && captionEmail && Number.isInteger(amountCents)) {
        const identityHash = emailHash(captionEmail);
        for (const [otherSha256, record] of Object.entries(state.images)) {
          if (otherSha256 === sha256 || record.status !== 'COMPLETED') continue;
          if (record.email_hash !== identityHash || record.amount_cents !== amountCents) continue;
          const distance = hammingDistance(phash, record.phash);
          if (distance !== null && distance <= phashMaxDistance) {
            persist();
            return { duplicate: true, matchType: 'PHASH', record, distance };
          }
        }
      }
      persist();
      return { duplicate: false, record: current || null };
    },

    releaseImage(sha256) {
      if (state.images[sha256]?.status === 'PROCESSING') {
        delete state.images[sha256];
        persist();
      }
    },

    claimTransaction(transactionKey, { processingId, groupIdHash }) {
      if (typeof transactionKey !== 'string' || transactionKey.length < 1) {
        throw new Error('Invalid transaction key');
      }
      prune();
      const existing = state.transactions[transactionKey];
      if (existing) return { duplicate: true, record: existing };
      const record = {
        processing_id: processingId,
        group_id_hash: groupIdHash,
        first_seen_at: Date.now(),
      };
      state.transactions[transactionKey] = record;
      trim(state.transactions);
      persist();
      return { duplicate: false, record };
    },
  };
}

module.exports = { createDuplicateStore, hammingDistance };

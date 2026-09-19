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

function messageKeySnapshot(messageKey) {
  if (!messageKey || typeof messageKey !== 'object') return null;
  const snapshot = {};
  for (const key of ['remoteJid', 'id', 'participant', 'participantAlt']) {
    if (typeof messageKey[key] === 'string' && messageKey[key].length <= 256) snapshot[key] = messageKey[key];
  }
  if (typeof messageKey.fromMe === 'boolean') snapshot.fromMe = messageKey.fromMe;
  return snapshot.remoteJid && snapshot.id ? snapshot : null;
}

function receiptFingerprint({
  captionEmail,
  amountCents,
  transactionId,
  paymentDate,
  paymentMonth,
  paymentDay,
  paymentHour,
  minutes,
}) {
  const email = captionEmail ? emailHash(captionEmail) : null;
  const normalizedTransactionId = typeof transactionId === 'string' && transactionId.trim()
    ? transactionId.trim().toLowerCase()
    : null;
  const hasDate = typeof paymentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
    || Number.isInteger(paymentMonth) && Number.isInteger(paymentDay);
  const hasTime = Number.isInteger(paymentHour) && Number.isInteger(minutes);
  // A pHash is only useful as a duplicate proof when it is paired with a
  // payment-specific identifier or a complete receipt date/time. Email and
  // amount alone are intentionally insufficient because one customer can
  // make many same-amount payments and Cash App layouts are repetitive.
  if (!normalizedTransactionId && !(hasDate && hasTime)) return null;
  return crypto.createHash('sha256').update(JSON.stringify({
    email,
    amount_cents: Number.isInteger(amountCents) ? amountCents : null,
    transaction_id: normalizedTransactionId,
    payment_date: typeof paymentDate === 'string' ? paymentDate : null,
    payment_month: Number.isInteger(paymentMonth) ? paymentMonth : null,
    payment_day: Number.isInteger(paymentDay) ? paymentDay : null,
    payment_hour: Number.isInteger(paymentHour) ? paymentHour : null,
    minutes: Number.isInteger(minutes) ? minutes : null,
  })).digest('hex').slice(0, 32);
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
    claimImage({ sha256, processingId, groupIdHash, groupName, messageKey, captionEmail, amountCents }) {
      if (!/^[0-9a-f]{64}$/i.test(sha256 || '')) throw new Error('Invalid image SHA-256');
      prune();
      const existing = state.images[sha256];
      if (existing?.processing_id === processingId && existing.status === 'PROCESSING') {
        return { duplicate: false, resumed: true, record: existing };
      }
      if (existing) return { duplicate: true, matchType: 'SHA256', record: existing };

      const record = {
        processing_id: processingId,
        group_id_hash: groupIdHash,
        group_name: typeof groupName === 'string' ? groupName : null,
        message_key: messageKeySnapshot(messageKey),
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

    registerImageEvidence({
      sha256,
      phash,
      captionEmail,
      amountCents,
      transactionId,
      paymentDate,
      paymentMonth,
      paymentDay,
      paymentHour,
      minutes,
      stripeChargeId,
      verificationVerdict,
      verificationReason,
      processingId,
    }) {
      prune();
      const current = state.images[sha256];
      if (current) {
        current.phash = typeof phash === 'string' ? phash.toLowerCase() : null;
        current.email_hash = captionEmail ? emailHash(captionEmail) : current.email_hash;
        current.amount_cents = Number.isInteger(amountCents) ? amountCents : current.amount_cents;
        current.evidence_fingerprint = receiptFingerprint({
          captionEmail,
          amountCents,
          transactionId,
          paymentDate,
          paymentMonth,
          paymentDay,
          paymentHour,
          minutes,
        });
        current.stripe_charge_id = typeof stripeChargeId === 'string' ? stripeChargeId : null;
        current.verification_verdict = typeof verificationVerdict === 'string' ? verificationVerdict : null;
        current.verification_reason = typeof verificationReason === 'string' ? verificationReason : null;
        current.status = 'COMPLETED';
      }

      const currentFingerprint = current?.evidence_fingerprint;
      if (typeof phash === 'string' && currentFingerprint && typeof stripeChargeId === 'string' && stripeChargeId) {
        for (const [otherSha256, record] of Object.entries(state.images)) {
          if (otherSha256 === sha256 || record.status !== 'COMPLETED') continue;
          if (record.evidence_fingerprint !== currentFingerprint) continue;
          // Date/time, amount, and email are not unique payment identity:
          // separate same-minute payments can share all three. A visual
          // near-match is therefore usable only when both receipts resolve
          // to the same canonical Stripe charge. Exact SHA-256 remains the
          // independent duplicate proof for byte-identical resends.
          if (!record.stripe_charge_id || record.stripe_charge_id !== stripeChargeId) continue;
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

    claimTransaction(transactionKey, { processingId, groupIdHash, groupName, messageKey }) {
      if (typeof transactionKey !== 'string' || transactionKey.length < 1) {
        throw new Error('Invalid transaction key');
      }
      prune();
      const existing = state.transactions[transactionKey];
      if (existing?.processing_id === processingId) {
        return { duplicate: false, resumed: true, record: existing };
      }
      if (existing) return { duplicate: true, record: existing };
      const record = {
        processing_id: processingId,
        group_id_hash: groupIdHash,
        group_name: typeof groupName === 'string' ? groupName : null,
        message_key: messageKeySnapshot(messageKey),
        first_seen_at: Date.now(),
      };
      state.transactions[transactionKey] = record;
      trim(state.transactions);
      persist();
      return { duplicate: false, record };
    },

    getClaimedTransactionIds(limit = 2048) {
      const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 2048;
      return Object.entries(state.transactions)
        .filter(([key, record]) => key.startsWith('stripe:') && record && Number.isInteger(record.first_seen_at))
        .sort(([, left], [, right]) => right.first_seen_at - left.first_seen_at)
        .slice(0, safeLimit)
        .map(([key]) => key.slice('stripe:'.length));
    },
  };
}

module.exports = { createDuplicateStore, hammingDistance };

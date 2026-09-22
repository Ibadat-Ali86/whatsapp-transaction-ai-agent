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

function quotedMessageSnapshot(message) {
  const key = messageKeySnapshot(message?.key);
  const content = message?.message;
  if (!key || !content || typeof content !== 'object') return null;

  // Preserve enough of the original Baileys envelope to quote it later,
  // while excluding thumbnails and arbitrary binary payloads.
  const snapshot = {};
  for (const field of ['imageMessage', 'documentMessage', 'extendedTextMessage', 'conversation']) {
    if (content[field] === undefined) continue;
    try {
      const value = JSON.parse(JSON.stringify(content[field], (name, entry) => {
        if (['jpegThumbnail', 'thumbnail', 'thumbnailDirectPath'].includes(name)) return undefined;
        if (typeof entry === 'string' && entry.length > 4096) return entry.slice(0, 4096);
        return entry;
      }));
      snapshot[field] = value;
    } catch (_error) {
      // The group annotation can still be sent without a quote.
    }
  }
  return Object.keys(snapshot).length ? { key, message: snapshot } : { key };
}

function imageOccurrences(record) {
  if (!record || typeof record !== 'object') return [];
  return [record, ...(Array.isArray(record.occurrences) ? record.occurrences : [])]
    .filter(occurrence => occurrence && typeof occurrence === 'object');
}

function confirmedStripeChargeIds(record) {
  return [...new Set(imageOccurrences(record)
    .filter(occurrence => occurrence.verification_verdict === 'VALID')
    .map(occurrence => occurrence.stripe_charge_id)
    .filter(chargeId => typeof chargeId === 'string' && chargeId.length > 0))];
}

function storedTransactionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function storedCustomerName(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ').toLowerCase()
    : null;
}

function receiptFingerprint({
  captionEmail,
  amountCents,
  transactionId,
  customerName,
  paymentDate,
  paymentMonth,
  paymentDay,
  paymentHour,
  minutes,
  includeCustomerName = true,
  includeTransactionId = true,
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
    transaction_id: includeTransactionId ? normalizedTransactionId : null,
    customer_name: includeCustomerName ? storedCustomerName(customerName) : null,
    payment_date: typeof paymentDate === 'string' ? paymentDate : null,
    payment_month: Number.isInteger(paymentMonth) ? paymentMonth : null,
    payment_day: Number.isInteger(paymentDay) ? paymentDay : null,
    payment_hour: Number.isInteger(paymentHour) ? paymentHour : null,
    minutes: Number.isInteger(minutes) ? minutes : null,
  })).digest('hex').slice(0, 32);
}

function visualReceiptFingerprint({
  amountCents,
  paymentDate,
  paymentMonth,
  paymentDay,
  paymentHour,
  minutes,
}) {
  const hasDate = typeof paymentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
    || Number.isInteger(paymentMonth) && Number.isInteger(paymentDay);
  const hasTime = Number.isInteger(paymentHour) && Number.isInteger(minutes);
  if (!Number.isInteger(amountCents) || amountCents <= 0 || !hasDate || !hasTime) return null;
  return crypto.createHash('sha256').update(JSON.stringify({
    amount_cents: amountCents,
    payment_date: typeof paymentDate === 'string' ? paymentDate : null,
    payment_month: Number.isInteger(paymentMonth) ? paymentMonth : null,
    payment_day: Number.isInteger(paymentDay) ? paymentDay : null,
    payment_hour: Number.isInteger(paymentHour) ? paymentHour : null,
    minutes: Number.isInteger(minutes) ? minutes : null,
  })).digest('hex').slice(0, 32);
}

function occurrenceVisualReceiptFingerprint(occurrence) {
  return occurrence?.visual_evidence_fingerprint || visualReceiptFingerprint({
    amountCents: occurrence?.amount_cents,
    paymentDate: occurrence?.payment_date,
    paymentMonth: occurrence?.payment_month,
    paymentDay: occurrence?.payment_day,
    paymentHour: occurrence?.payment_hour,
    minutes: occurrence?.minutes,
  });
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
    claimImage({ sha256, processingId, groupIdHash, groupName, messageKey, message, captionEmail, amountCents }) {
      if (!/^[0-9a-f]{64}$/i.test(sha256 || '')) throw new Error('Invalid image SHA-256');
      prune();
      const existing = state.images[sha256];
      if (existing?.processing_id === processingId && existing.status === 'PROCESSING') {
        return { duplicate: false, resumed: true, record: existing };
      }
      if (existing) {
        return {
          duplicate: true,
          matchType: 'SHA256',
          record: existing,
          confirmed_stripe_charge_ids: confirmedStripeChargeIds(existing),
          proof: {
            image_sha256: sha256,
            transaction_id: storedTransactionId(existing.transaction_id),
            evidence_fingerprint: existing.evidence_fingerprint || null,
          },
        };
      }

      const record = {
        processing_id: processingId,
        group_id_hash: groupIdHash,
        group_name: typeof groupName === 'string' ? groupName : null,
        message_key: messageKeySnapshot(messageKey),
        quoted_message: quotedMessageSnapshot(message),
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
      customerName,
      paymentDate,
      paymentMonth,
      paymentDay,
      paymentHour,
      minutes,
      stripeChargeId,
      verificationVerdict,
      verificationReason,
      processingId,
      groupIdHash,
      groupName,
      messageKey,
      message,
    }) {
      prune();
      const current = state.images[sha256];
      let currentEvidence = null;
      if (current) {
        const evidence = {
          phash: typeof phash === 'string' ? phash.toLowerCase() : null,
          email_hash: captionEmail ? emailHash(captionEmail) : null,
          amount_cents: Number.isInteger(amountCents) ? amountCents : null,
          transaction_id: storedTransactionId(transactionId),
          customer_name: storedCustomerName(customerName),
          payment_date: typeof paymentDate === 'string' ? paymentDate : null,
          payment_month: Number.isInteger(paymentMonth) ? paymentMonth : null,
          payment_day: Number.isInteger(paymentDay) ? paymentDay : null,
          payment_hour: Number.isInteger(paymentHour) ? paymentHour : null,
          minutes: Number.isInteger(minutes) ? minutes : null,
          evidence_fingerprint: receiptFingerprint({
            captionEmail,
            amountCents,
            transactionId,
            customerName,
            paymentDate,
            paymentMonth,
            paymentDay,
            paymentHour,
            minutes,
          }),
          visual_evidence_fingerprint: visualReceiptFingerprint({
            amountCents,
            paymentDate,
            paymentMonth,
            paymentDay,
            paymentHour,
            minutes,
          }),
          legacy_evidence_fingerprint: receiptFingerprint({
            captionEmail,
            amountCents,
            transactionId,
            paymentDate,
            paymentMonth,
            paymentDay,
            paymentHour,
            minutes,
            includeCustomerName: false,
          }),
          stripe_charge_id: typeof stripeChargeId === 'string' ? stripeChargeId : null,
          verification_verdict: typeof verificationVerdict === 'string' ? verificationVerdict : null,
          verification_reason: typeof verificationReason === 'string' ? verificationReason : null,
          processing_id: processingId,
          group_id_hash: typeof groupIdHash === 'string' ? groupIdHash : current.group_id_hash || null,
          group_name: typeof groupName === 'string' ? groupName : current.group_name || null,
          message_key: messageKeySnapshot(messageKey) || current.message_key || null,
          quoted_message: quotedMessageSnapshot(message) || current.quoted_message || null,
          first_seen_at: Date.now(),
        };
        if (current.processing_id === processingId) {
          Object.assign(current, evidence);
          currentEvidence = current;
        } else {
          current.occurrences = Array.isArray(current.occurrences) ? current.occurrences : [];
          const existingOccurrence = current.occurrences.find(item => item.processing_id === processingId);
          if (existingOccurrence) Object.assign(existingOccurrence, evidence);
          else current.occurrences.push(evidence);
          currentEvidence = existingOccurrence || current.occurrences[current.occurrences.length - 1];
        }
        current.status = 'COMPLETED';
      }

      const currentFingerprint = currentEvidence?.evidence_fingerprint;
      const currentVisualFingerprint = currentEvidence?.visual_evidence_fingerprint;
      let conflictingMatch = null;

      // The normalized receipt fingerprint is stronger than visual
      // similarity when it contains an explicit payment identifier. WhatsApp
      // can resize/re-encode an image enough to make pHash unavailable or
      // exceed its visual threshold, while the same provider identifier,
      // amount, and receipt time remain stable. Use this deterministic proof
      // before the visual fallback. A later attempt with the first fresh
      // Stripe charge is intentionally allowed through when the prior record
      // was unresolved, so a missed first lookup cannot suppress approval.
      const currentTransactionId = storedTransactionId(currentEvidence?.transaction_id);
      const currentCustomerName = storedCustomerName(currentEvidence?.customer_name);
      if (currentFingerprint && currentTransactionId) {
        for (const [otherSha256, record] of Object.entries(state.images)) {
          if (otherSha256 === sha256 || record.status !== 'COMPLETED') continue;
          for (const occurrence of imageOccurrences(record)) {
            if (
              ![
                currentFingerprint,
                currentEvidence?.legacy_evidence_fingerprint,
              ].includes(occurrence.evidence_fingerprint)
              || storedTransactionId(occurrence.transaction_id) !== currentTransactionId
            ) continue;

            const priorChargeId = typeof occurrence.stripe_charge_id === 'string' && occurrence.stripe_charge_id
              ? occurrence.stripe_charge_id
              : null;
            const currentChargeId = typeof stripeChargeId === 'string' && stripeChargeId
              ? stripeChargeId
              : null;

            if (priorChargeId && currentChargeId && priorChargeId !== currentChargeId) {
              conflictingMatch = { record: occurrence, distance: null };
              continue;
            }

            if (!priorChargeId || priorChargeId === currentChargeId) {
              // If the current attempt is the first one with a canonical
              // charge and the previous attempt had none, preserve the
              // current VALID result. All other combinations are repeats.
              if (priorChargeId || !currentChargeId) {
                persist();
                return {
                  duplicate: true,
                  matchType: 'TRANSACTION_EVIDENCE',
                  record: occurrence,
                  proof: {
                    transaction_id: currentTransactionId,
                    evidence_fingerprint: currentFingerprint,
                    stripe_charge_id: priorChargeId || currentChargeId || null,
                  },
                };
              }
            }
          }
        }
      }

      if (
        typeof phash === 'string'
        && (currentFingerprint || currentVisualFingerprint)
        && (
          (typeof stripeChargeId === 'string' && stripeChargeId)
          || currentTransactionId
          || currentCustomerName
          || currentVisualFingerprint
        )
      ) {
        for (const [otherSha256, record] of Object.entries(state.images)) {
          if (otherSha256 === sha256 || record.status !== 'COMPLETED') continue;
          for (const occurrence of imageOccurrences(record)) {
            const sameEvidenceFingerprint = [
              currentFingerprint,
              currentEvidence?.legacy_evidence_fingerprint,
            ].includes(occurrence.evidence_fingerprint);
            const sameVisualFingerprint = currentVisualFingerprint
              && occurrenceVisualReceiptFingerprint(occurrence) === currentVisualFingerprint;
            // Older valid records may predate canonical Stripe date/time
            // persistence and therefore have no receipt fingerprint. Keep
            // those records useful after a deployment, but require the
            // strongest remaining same-group evidence: a previously VALID
            // Stripe charge, same amount and identity, and an exact/near
            // identical visual hash. This is intentionally narrower than
            // the normal visual fallback and never bypasses a different
            // current Stripe charge (handled below as a conflict).
            const sameLegacyValidatedGroupReceipt = occurrence.verification_verdict === 'VALID'
              && Boolean(occurrence.stripe_charge_id)
              && occurrence.group_id_hash
              && currentEvidence.group_id_hash
              && occurrence.group_id_hash === currentEvidence.group_id_hash
              && !occurrence.evidence_fingerprint
              && Boolean(currentFingerprint)
              && Number.isInteger(occurrence.amount_cents)
              && occurrence.amount_cents === currentEvidence.amount_cents
              && (
                occurrence.email_hash
                && currentEvidence.email_hash
                && occurrence.email_hash === currentEvidence.email_hash
                || storedCustomerName(occurrence.customer_name)
                && currentCustomerName
                && storedCustomerName(occurrence.customer_name) === currentCustomerName
              );
            if (!sameEvidenceFingerprint && !sameVisualFingerprint && !sameLegacyValidatedGroupReceipt) continue;
            const distance = hammingDistance(phash, occurrence.phash);
            if (distance !== null && distance <= phashMaxDistance) {
              // Visual similarity is duplicate proof only when both images
              // resolve to the same canonical Stripe charge.
              if (occurrence.stripe_charge_id && occurrence.stripe_charge_id === stripeChargeId) {
                persist();
                return { duplicate: true, matchType: 'PHASH', record: occurrence, distance };
              }
              if (occurrence.stripe_charge_id
                && typeof stripeChargeId === 'string'
                && stripeChargeId
                && occurrence.stripe_charge_id !== stripeChargeId) {
                // A visually equivalent receipt with a different Stripe
                // charge is not proof of a new payment. Preserve the evidence
                // but block automatic approval so the caller can return an
                // auditable review.
                conflictingMatch = { record: occurrence, distance };
                continue;
              }
              // When Stripe was unavailable or OCR did not produce a usable
              // lookup, an exact payment identifier plus near-identical
              // receipt image is still deterministic duplicate evidence. Do
              // not use email/amount/time alone: those fields can repeat for
              // legitimate payments. If the current attempt has a fresh
              // canonical charge while the prior attempt does not, let the
              // current attempt become the first approved claim instead of
              // suppressing the only successful verification.
              const sameTransactionId = storedTransactionId(occurrence.transaction_id)
                && storedTransactionId(currentEvidence?.transaction_id)
                && storedTransactionId(occurrence.transaction_id) === storedTransactionId(currentEvidence.transaction_id);
              const sameCustomerReceipt = !currentTransactionId
                && storedCustomerName(occurrence.customer_name)
                && currentCustomerName
                && storedCustomerName(occurrence.customer_name) === currentCustomerName;
              const sameValidatedGroupFingerprint = occurrence.verification_verdict === 'VALID'
                && Boolean(occurrence.stripe_charge_id)
                && occurrence.group_id_hash
                && currentEvidence.group_id_hash
                && occurrence.group_id_hash === currentEvidence.group_id_hash
                && Boolean(currentFingerprint)
                && occurrence.evidence_fingerprint === currentFingerprint;
              const samePaymentEvidence = sameTransactionId || sameCustomerReceipt;
              // The visual-only fallback is deliberately stricter than the
              // normal pHash near-match path. Exact pHash equality is needed
              // because amount/date/time can repeat across legitimate
              // payments; the visual signal must represent the same receipt,
              // not merely the same Cash App layout.
              const sameVisualReceipt = Boolean(sameVisualFingerprint) && distance === 0;
              const sameDuplicateEvidence = samePaymentEvidence
                || sameVisualReceipt
                || sameValidatedGroupFingerprint
                || sameLegacyValidatedGroupReceipt && distance <= Math.min(phashMaxDistance, 1);
              if (
                sameDuplicateEvidence
                && (
                  occurrence.stripe_charge_id
                  || stripeChargeId
                  || !occurrence.stripe_charge_id && !stripeChargeId
                )
              ) {
                if (!occurrence.stripe_charge_id && stripeChargeId) continue;
                persist();
                return {
                  duplicate: true,
                  matchType: sameVisualReceipt
                    && !samePaymentEvidence
                    ? 'PHASH_VISUAL_RECEIPT'
                    : sameValidatedGroupFingerprint
                      && !samePaymentEvidence
                      ? 'PHASH_VALIDATED_GROUP_RECEIPT'
                    : sameLegacyValidatedGroupReceipt
                      && !samePaymentEvidence
                      ? 'PHASH_VALIDATED_GROUP_LEGACY_RECEIPT'
                    : sameTransactionId ? 'PHASH_TRANSACTION_ID' : 'PHASH_RECEIPT_EVIDENCE',
                  record: occurrence,
                  distance,
                  proof: {
                    transaction_id: storedTransactionId(currentEvidence.transaction_id),
                    customer_name: currentCustomerName,
                    amount_cents: currentEvidence.amount_cents,
                    payment_month: currentEvidence.payment_month,
                    payment_day: currentEvidence.payment_day,
                    payment_hour: currentEvidence.payment_hour,
                    minutes: currentEvidence.minutes,
                    visual_evidence_fingerprint: currentVisualFingerprint,
                    evidence_fingerprint: currentFingerprint,
                  },
                };
              }
            }
          }
        }
      }
      if (conflictingMatch) {
        if (currentEvidence) {
          currentEvidence.verification_verdict = 'UNCLEAR';
          currentEvidence.verification_reason = 'IMAGE_MATCH_DIFFERENT_STRIPE_CHARGE';
        }
        persist();
        return {
          duplicate: false,
          conflict: true,
          matchType: 'PHASH_DIFFERENT_STRIPE_CHARGE',
          record: conflictingMatch.record,
          distance: conflictingMatch.distance,
        };
      }
      persist();
      return { duplicate: false, record: currentEvidence || current || null };
    },

    releaseImage(sha256) {
      if (state.images[sha256]?.status === 'PROCESSING') {
        delete state.images[sha256];
        persist();
      }
    },

    claimTransaction(transactionKey, { processingId, groupIdHash, groupName, messageKey, message }) {
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
        quoted_message: quotedMessageSnapshot(message),
        first_seen_at: Date.now(),
      };
      state.transactions[transactionKey] = record;
      trim(state.transactions);
      persist();
      return { duplicate: false, record };
    },

    getClaimedTransactionIds(limit = 2048) {
      const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 2048;
      prune();

      // The transaction ledger is the normal source of claims. Keep valid
      // image evidence as a compatibility/recovery source as well: records
      // written by an older bot version, or a process that completed image
      // registration before a restart, can contain a canonical Stripe charge
      // without a corresponding entry in state.transactions. Only evidence
      // explicitly marked VALID is eligible here; unresolved/review records
      // must never exclude a Stripe charge or influence approval.
      const claimed = new Map();
      const remember = (chargeId, firstSeenAt) => {
        if (typeof chargeId !== 'string' || !chargeId.trim()) return;
        const normalizedChargeId = chargeId.trim();
        const timestamp = Number.isInteger(firstSeenAt) ? firstSeenAt : 0;
        const existing = claimed.get(normalizedChargeId);
        if (!existing || timestamp > existing.first_seen_at) {
          claimed.set(normalizedChargeId, { first_seen_at: timestamp });
        }
      };

      for (const [key, record] of Object.entries(state.transactions)) {
        if (!key.startsWith('stripe:') || !record || !Number.isInteger(record.first_seen_at)) continue;
        remember(key.slice('stripe:'.length), record.first_seen_at);
      }

      for (const record of Object.values(state.images)) {
        for (const occurrence of imageOccurrences(record)) {
          if (occurrence?.verification_verdict !== 'VALID') continue;
          remember(occurrence.stripe_charge_id, occurrence.first_seen_at || record?.first_seen_at);
        }
      }

      return [...claimed.entries()]
        .sort(([, left], [, right]) => right.first_seen_at - left.first_seen_at)
        .slice(0, safeLimit)
        .map(([chargeId]) => chargeId);
    },
  };
}

module.exports = { createDuplicateStore, hammingDistance };

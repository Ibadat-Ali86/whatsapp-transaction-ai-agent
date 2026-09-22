/**
 * Reconcile simultaneous screenshots against Stripe's already-sanitized
 * candidate lists. This module never invents candidates: it only selects a
 * globally unique one-to-one assignment when the evidence has one clear best
 * mapping. Equal or near-equal assignments remain unresolved.
 */

function normalized(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function candidateId(candidate) {
  return typeof candidate?.stripe_charge_id === 'string' && candidate.stripe_charge_id.trim()
    ? candidate.stripe_charge_id.trim()
    : null;
}

function parseReceiptTimestamp(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const date = typeof fields.payment_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fields.payment_date)
    ? fields.payment_date
    : null;
  const hour = Number(fields.payment_hour);
  const minute = Number(fields.minutes);
  if (!date || !Number.isInteger(hour) || !Number.isInteger(minute)
    || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const timestamp = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseCandidateTimestamp(candidate) {
  if (typeof candidate?.payment_date !== 'string' || typeof candidate?.payment_time !== 'string') return null;
  const timestamp = Date.parse(`${candidate.payment_date}T${candidate.payment_time}:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function scoreCandidate(entry, candidate) {
  const fields = entry?.result?.fields || {};
  const verification = entry?.result?.verification || {};
  const receiptEmail = normalized(entry?.job?.caption_email || fields.email);
  const receiptName = normalized(fields.customer_name);
  const receiptIdentifier = normalized(fields.transaction_id);
  const candidateEmail = normalized(candidate?.customer_email);
  const candidateName = normalized(candidate?.customer_name);
  const candidateIdentifier = normalized(candidate?.payment_identifier);
  const amountMatches = Number.isInteger(fields.amount_cents)
    && Number.isInteger(candidate?.amount_cents)
    && fields.amount_cents === candidate.amount_cents;

  let score = amountMatches ? 1 : 0;
  let discriminatorScore = 0;
  if (receiptIdentifier && candidateIdentifier && receiptIdentifier === candidateIdentifier) {
    score += 10000;
    discriminatorScore += 10000;
  }
  if (receiptEmail && candidateEmail && receiptEmail === candidateEmail) {
    score += 1000;
    discriminatorScore += 1000;
  }
  if (receiptName && candidateName && receiptName === candidateName) {
    score += 500;
    discriminatorScore += 500;
  }

  const receiptTimestamp = parseReceiptTimestamp(fields);
  const candidateTimestamp = parseCandidateTimestamp(candidate);
  if (receiptTimestamp !== null && candidateTimestamp !== null) {
    const differenceMinutes = Math.abs(receiptTimestamp - candidateTimestamp) / 60000;
    // Candidate lists are already Stripe-eligible. Time is used here only to
    // distinguish a batch; it is never allowed to bypass Stripe eligibility.
    const timeScore = Math.max(0, 400 - Math.min(400, differenceMinutes));
    score += timeScore;
    discriminatorScore += timeScore;
  }

  // Keep the result shape stable for future callers and make it explicit that
  // a verification-level identity may be used when OCR omitted the field.
  if (!receiptEmail && normalized(verification?.matched_transaction?.customer_email)
    && normalized(verification.matched_transaction.customer_email) === candidateEmail) {
    score += 100;
    discriminatorScore += 100;
  }
  return { score, discriminatorScore };
}

function connectedComponents(entries) {
  const candidateToEntries = new Map();
  entries.forEach((entry, entryIndex) => {
    for (const candidate of entry.candidates) {
      const id = candidateId(candidate);
      if (!id) continue;
      const indexes = candidateToEntries.get(id) || new Set();
      indexes.add(entryIndex);
      candidateToEntries.set(id, indexes);
    }
  });

  const seen = new Set();
  const components = [];
  for (let start = 0; start < entries.length; start += 1) {
    if (seen.has(start)) continue;
    const entryIndexes = new Set([start]);
    const pending = [start];
    seen.add(start);
    while (pending.length) {
      const entryIndex = pending.pop();
      for (const candidate of entries[entryIndex].candidates) {
        const id = candidateId(candidate);
        for (const linkedIndex of candidateToEntries.get(id) || []) {
          if (!seen.has(linkedIndex)) {
            seen.add(linkedIndex);
            entryIndexes.add(linkedIndex);
            pending.push(linkedIndex);
          }
        }
      }
    }
    components.push([...entryIndexes].sort((left, right) => left - right));
  }
  return components;
}

function bestAssignment(entries, maxAssignments = 512) {
  if (!entries.length || entries.length > 8) return null;
  if (entries.some(entry => entry.candidates.length === 0)) return null;

  const ordered = [...entries].sort((left, right) => left.candidates.length - right.candidates.length);
  const assignments = [];
  const used = new Set();
  const current = [];

  const visit = (index, score) => {
    if (assignments.length >= maxAssignments) return;
    if (index === ordered.length) {
      assignments.push({ score, assignment: [...current] });
      return;
    }
    const entry = ordered[index];
    for (const candidate of entry.candidates) {
      const id = candidateId(candidate);
      if (!id || used.has(id)) continue;
      used.add(id);
      const candidateScore = scoreCandidate(entry, candidate);
      current.push({ entry, candidate, ...candidateScore });
      visit(index + 1, score + candidateScore.score);
      current.pop();
      used.delete(id);
    }
  };
  visit(0, 0);

  assignments.sort((left, right) => right.score - left.score);
  const best = assignments[0];
  const second = assignments[1] || null;
  if (!best || (second && best.score === second.score)) return null;
  // A one-point amount-only difference is not a meaningful discriminator.
  if (best.assignment.some(item => item.discriminatorScore <= 0)) return null;
  if (second && best.score - second.score < 10) return null;
  return best.assignment;
}

function reconcileCandidateBatch(rawEntries, { maxEntries = 8 } = {}) {
  const entries = (Array.isArray(rawEntries) ? rawEntries : [])
    .map(entry => ({
      ...entry,
      candidates: Array.isArray(entry?.result?.verification?.candidate_transactions)
        ? entry.result.verification.candidate_transactions
          .filter(candidate => candidateId(candidate))
          .filter((candidate, index, values) => values.findIndex(value => candidateId(value) === candidateId(candidate)) === index)
        : [],
    }))
    .filter(entry => entry.processingId && entry.candidates.length > 1)
    .slice(0, maxEntries);

  const assignments = new Map();
  for (const componentIndexes of connectedComponents(entries)) {
    const component = componentIndexes.map(index => entries[index]);
    const best = bestAssignment(component);
    if (!best) continue;
    for (const item of best) assignments.set(item.entry.processingId, item.candidate);
  }
  return assignments;
}

module.exports = { reconcileCandidateBatch, scoreCandidate };

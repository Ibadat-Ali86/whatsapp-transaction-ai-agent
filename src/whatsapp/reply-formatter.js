/**
 * Formats the OCR result into a human-readable WhatsApp message.
 * @param {object} ocrResult - The result from the OCR service
 * @param {string} processingId - The unique processing ID
 * @param {string|null} captionEmail - The normalized WhatsApp caption email
 * @returns {string} The formatted reply message
 */
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return 'Not available';
  const [local, domain] = email.trim().split('@');
  if (!local || !domain) return 'Not available';
  if (local.length === 1) return `*@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

function maskIdentifier(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Not available';
  const identifier = value.trim();
  const separator = identifier.indexOf('_');
  const prefix = separator > 0 ? identifier.slice(0, separator + 1) : identifier.slice(0, 2);
  return `${prefix}…${identifier.slice(-6)}`;
}

function safeEvidenceValue(value, fallback = 'Not available') {
  if (value == null || value === '') return fallback;
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 160) || fallback;
}

function formatReceiptEvidence(ocrResult) {
  const fields = ocrResult?.fields || {};
  const amount = Number.isInteger(fields.amount_cents)
    ? `$${(fields.amount_cents / 100).toFixed(2)}`
    : fields.amount != null ? `$${safeEvidenceValue(fields.amount)}` : 'Not extracted';
  const date = fields.payment_date
    || (fields.payment_month && fields.payment_day
      ? `${String(fields.payment_month).padStart(2, '0')}-${String(fields.payment_day).padStart(2, '0')}`
      : 'Not extracted');
  const hasTime = fields.payment_hour != null && fields.minutes != null;
  const time = hasTime
    ? `${String(fields.payment_hour).padStart(2, '0')}:${String(fields.minutes).padStart(2, '0')}`
    : 'Not extracted';
  const email = fields.email ? maskEmail(fields.email) : 'Not extracted';
  const transactionId = fields.transaction_id
    ? safeEvidenceValue(fields.transaction_id)
    : 'Not extracted';
  const description = fields.description
    ? safeEvidenceValue(fields.description)
    : 'Not present in the screenshot';

  return `\n🧾 *Receipt evidence received*\n💰 Amount: ${amount}\n📅 Receipt date: ${date}\n🕒 Receipt time: ${time}\n👤 Customer name: ${safeEvidenceValue(fields.customer_name, 'Not extracted')}\n📧 Receipt email: ${email}\n🆔 Payment identifier: ${transactionId}\n📝 Receipt description: ${description}`;
}

function formatReviewJustification(ocrResult, verification) {
  const fields = ocrResult?.fields || {};
  const reason = verification?.reason_code || '';
  const candidateCount = Number.isInteger(verification?.candidate_count)
    ? verification.candidate_count
    : null;
  const identifier = fields.transaction_id ? safeEvidenceValue(fields.transaction_id) : null;

  if (identifier && (
    reason === 'MULTIPLE_EXACT_MATCHES'
    || reason === 'MULTIPLE_IDENTITY_RECOVERY_MATCHES'
    || reason === 'MULTIPLE_TRANSACTION_ID_MATCHES'
    || reason === 'NO_EXACT_MATCH'
  )) {
    return `🔎 *Why review:* The receipt supplied payment identifier ${identifier}, but it did not resolve to exactly one eligible succeeded Stripe Cash App charge in the bounded reconciliation search${candidateCount != null ? ` (${candidateCount} eligible candidate${candidateCount === 1 ? '' : 's'} remained)` : ''}. A visible screenshot field is not treated as proof until Stripe confirms it. The bot did not choose the newest record arbitrarily.`;
  }
  if (reason === 'MULTIPLE_EXACT_MATCHES' || reason === 'MULTIPLE_IDENTITY_RECOVERY_MATCHES') {
    return '🔎 *Why review:* Amount, status, method, and available date/time/identity evidence matched more than one Stripe charge. Recency alone is not proof of which payment this screenshot represents, so no candidate was approved.';
  }
  if (reason === 'MULTIPLE_TRANSACTION_ID_MATCHES') {
    return '🔎 *Why review:* The provider identifier was associated with multiple eligible Stripe records. Because the identifier was not unique, no record was selected.';
  }
  if (reason === 'NO_EXACT_MATCH') {
    return '🔎 *Why review:* Stripe did not return one eligible succeeded Cash App charge satisfying the available amount, status, method, and receipt identity/time constraints. A visible screenshot field is not treated as proof until Stripe confirms it.';
  }
  return '🔎 *Why review:* The available evidence did not identify exactly one eligible Stripe charge, so the bot kept the result review-required instead of guessing or approving an unproven payment.';
}

function formatOcrReply(ocrResult, processingId, captionEmail = null) {
  // The OCR API returns extracted values under `fields`. Accepting the
  // legacy top-level shape as well keeps this formatter backward-compatible.
  const fields = ocrResult?.fields || ocrResult || {};
  const verification = ocrResult?.verification;
  const stripeTransaction = verification?.matched_transaction || {};
  const providedCaptionEmail = typeof captionEmail === 'string' && captionEmail.trim()
    ? captionEmail.trim()
    : typeof ocrResult?.caption_email === 'string' && ocrResult.caption_email.trim()
      ? ocrResult.caption_email.trim()
      : null;
  const captionEmailPresent = Boolean(providedCaptionEmail);
  const canonicalStripeEmail = typeof stripeTransaction.customer_email === 'string'
    ? stripeTransaction.customer_email
    : null;
  const stripeChargeId = verification?.stripe_charge_id || stripeTransaction.stripe_charge_id;
  const amountCents = stripeTransaction.amount_cents ?? fields.amount_cents;
  const amount = amountCents != null
    ? `$${(amountCents / 100).toFixed(2)}`
    : fields.amount != null ? `$${fields.amount}` : 'Not found';
  const minutes = stripeTransaction.minutes ?? fields.minutes ?? 'Not found';
  const dateStr = stripeTransaction.payment_date || fields.payment_date || fields.date || 'Not found';
  const name = stripeTransaction.customer_name || fields.customer_name || fields.name || 'Not found';
  const description = stripeTransaction.description || fields.description || 'Not found';
  const status = stripeTransaction.status || fields.status || 'Not found';
  const currency = stripeTransaction.currency || 'Not available';
  const paymentMethod = stripeTransaction.payment_method_type || 'Not available';
  const paymentIdentifier = stripeTransaction.payment_identifier || fields.transaction_id;
  const stripeCustomerId = stripeTransaction.stripe_customer_id;
  const confidence = ocrResult?.confidence != null ? Math.round(ocrResult.confidence * 100) : 0;
  const provider = ocrResult?.provider || 'tesseract';
  const verdict = verification?.verdict || null;
  const screenshotStatus = verdict === 'VALID'
    ? 'ORIGINAL / VALID'
    : verdict === 'DUPLICATE'
      ? 'DUPLICATE'
      : verdict === 'ERROR'
        ? 'ERROR'
        : verdict === 'UNCLEAR'
          ? 'UNCLEAR / NOT CONFIRMED'
          : 'UNVERIFIED';

  let reply = `🔍 *Payment Screenshot Analysis*\n`;
  reply += `📋 Processing ID: ${processingId}\n\n`;
  reply += `📧 Caption email: ${providedCaptionEmail || 'Not provided'}\n`;
  if (canonicalStripeEmail) {
    reply += captionEmailPresent
      ? `📧 Email: ${canonicalStripeEmail}\n`
      : `📧 Verified Stripe email (masked): ${maskEmail(canonicalStripeEmail)}\n`;
  } else if (captionEmailPresent) {
    reply += `📧 Email: ${providedCaptionEmail}\n`;
  } else {
    reply += '📧 Verified Stripe email: Not available\n';
  }
  reply += `💰 Amount: ${amount}\n`;
  reply += `⏱ Minutes: ${minutes}\n`;
  reply += `📅 Date: ${dateStr}\n`;
  reply += `👤 Name: ${name}\n`;
  reply += `📝 Description: ${description}\n`;
  reply += `✅ Status: ${status}\n`;
  reply += `💱 Currency: ${currency}\n`;
  reply += `💳 Payment method: ${paymentMethod}\n`;
  if (paymentIdentifier) {
    reply += `🔢 Payment identifier: ${paymentIdentifier}\n`;
  }
  if (stripeCustomerId) {
    reply += `🆔 Stripe Customer (masked): ${maskIdentifier(stripeCustomerId)}\n`;
  }
  reply += '\n';
  reply += `${screenshotStatus === 'ORIGINAL / VALID' ? '✅' : screenshotStatus === 'DUPLICATE' ? '♻️' : '❌'} Screenshot Status: ${screenshotStatus}\n`;
  if (verification?.duplicate_of_processing_id) {
    reply += `🔁 Original Processing ID: ${verification.duplicate_of_processing_id}\n`;
  }
  reply += `\n`;

  if (stripeTransaction.payment_time) {
    reply += `🕒 Stripe Payment Time: ${stripeTransaction.payment_time}\n\n`;
  }
  reply += `📊 Confidence: ${confidence}%\n`;
  reply += `🔬 OCR Provider: ${provider}\n\n`;

  if (ocrResult?.fallback_reason === 'AI_PROVIDER_UNAVAILABLE') {
    reply += `⚠️ AI enhancement unavailable — result is from local OCR. Manual review recommended.\n\n`;
  }

  if (verification) {
    const marker = verdict === 'VALID' ? '✅' : verdict === 'DUPLICATE' ? '♻️' : '❌';
    reply += `${marker} Stripe Verification: ${verdict}\n`;
    if (verification.reason_code) {
      reply += `🧾 Verification Reason: ${verification.reason_code}\n`;
    }
    if (stripeChargeId) {
      reply += `🔗 Stripe Charge: ${captionEmailPresent ? stripeChargeId : maskIdentifier(stripeChargeId)}\n`;
    }
    if (!captionEmailPresent && verdict === 'VALID') {
      reply += '🔎 Justification: No email was supplied in the caption. Stripe uniquely matched exactly one eligible succeeded payment using the available receipt evidence. The bot did not invent an email; the displayed identity came from Stripe.\n';
    }
    reply += `\n`;
  }

  if (confidence < 50) {
    reply += `⚠️ Low confidence — manual review recommended\n\n`;
  }

  reply += `⚠️ _Note: This is automated extraction. Verify before acting on financial decisions._`;
  
  return reply;
}

function formatStripeCandidateReview(verification, ocrResult = {}) {
  const allCandidates = Array.isArray(verification?.candidate_transactions)
    ? verification.candidate_transactions.filter(candidate => candidate && typeof candidate === 'object')
    : [];
  if (!allCandidates.length) return '';
  // The API may retain the full sanitized candidate set for audit/debugging,
  // but a WhatsApp reply should expose only the newest candidate. This keeps
  // the response actionable and avoids implying that an older amount match
  // is also evidence for the submitted receipt.
  const candidates = allCandidates.slice(0, 1);

  const formatAmount = cents => Number.isInteger(cents)
    ? `$${(cents / 100).toFixed(2)}`
    : 'Not available';
  const formatValue = value => value == null || value === ''
    ? 'Not available'
    : String(value).replace(/\s+/g, ' ').slice(0, 160);
  const receiptDate = ocrResult?.fields?.payment_date || null;
  const newestCandidateDate = candidates[0]?.payment_date || null;
  const dateMismatch = receiptDate && newestCandidateDate && receiptDate !== newestCandidateDate;
  let report = '\n📚 *Newest Stripe Candidate (review context)*\n';
  report += `Only the newest of ${allCandidates.length} eligible candidate record${allCandidates.length === 1 ? '' : 's'} is shown below; no candidate was approved automatically.\n`;
  if (dateMismatch) {
    report += `⚠️ Receipt date ${receiptDate} does not match the newest Stripe candidate date ${newestCandidateDate}; it remains review-only.\n`;
  }
  candidates.forEach((candidate, index) => {
    const label = index === 0 ? 'Most Recent' : `Match ${index + 1}`;
    const paymentDate = candidate.payment_date || 'Not available';
    const paymentTime = candidate.payment_time || 'time unavailable';
    report += `\n🔹 *Candidate ${index + 1} — ${label}*\n`;
    report += `💰 Amount: ${formatAmount(candidate.amount_cents)}\n`;
    report += `✅ Status: ${formatValue(candidate.status)}\n`;
    report += `🕒 Stripe Time: ${paymentDate} ${paymentTime}\n`;
    report += `👤 Customer: ${formatValue(candidate.customer_name)}\n`;
    report += `📧 Email (masked): ${candidate.customer_email ? maskEmail(candidate.customer_email) : 'Not available'}\n`;
    report += `🆔 Stripe Customer: ${candidate.stripe_customer_id ? maskIdentifier(candidate.stripe_customer_id) : 'Not available'}\n`;
    report += `🔢 Payment identifier: ${candidate.payment_identifier ? maskIdentifier(candidate.payment_identifier) : 'Not available'}\n`;
    report += `💳 Method: ${formatValue(candidate.payment_method_type)}\n`;
    report += `📝 Description: ${formatValue(candidate.description)}\n`;
    report += `🔗 Stripe Charge: ${candidate.stripe_charge_id ? maskIdentifier(candidate.stripe_charge_id) : 'Not available'}\n`;
  });
  report += '\n🛑 No candidate was approved or claimed automatically. Client confirmation is required.\n';
  return report;
}

function formatPrivateStripeCandidateReview(ocrResult, processingId) {
  const verification = ocrResult?.verification || {};
  const candidates = Array.isArray(verification.candidate_transactions)
    ? verification.candidate_transactions.filter(candidate => candidate && typeof candidate === 'object')
    : [];
  const formatValue = value => value == null || value === ''
    ? 'Not available'
    : String(value).replace(/\s+/g, ' ').slice(0, 300);
  const formatAmount = candidate => Number.isInteger(candidate?.amount_cents)
    ? `${(candidate.amount_cents / 100).toFixed(2)} ${formatValue(candidate.currency || 'USD').toUpperCase()}`
    : 'Not available';

  let report = `🔒 *Private Stripe Payment Review*\n📋 Processing ID: ${formatValue(processingId)}\n`;
  report += `🧾 Verification reason: ${formatValue(verification.reason_code)}\n`;
  report += `📊 Eligible candidates: ${Number.isInteger(verification.candidate_count) ? verification.candidate_count : candidates.length}\n`;
  report += '⚠️ No candidate was approved automatically. Full candidate evidence is provided here for the authorized client/admin.\n';

  if (!candidates.length) {
    return `${report}\nStripe returned no sanitized candidate records. Review the Stripe dashboard privately.`;
  }

  candidates.forEach((candidate, index) => {
    const paymentDate = candidate.payment_date || 'Not available';
    const paymentTime = candidate.payment_time || 'time unavailable';
    report += `\n🔹 *Candidate ${index + 1}${index === 0 ? ' — Most Recent' : ''}*\n`;
    report += `💰 Amount: ${formatAmount(candidate)}\n`;
    report += `✅ Status: ${formatValue(candidate.status)}\n`;
    report += `🕒 Stripe Time: ${formatValue(paymentDate)} ${formatValue(paymentTime)}\n`;
    report += `👤 Customer: ${formatValue(candidate.customer_name)}\n`;
    report += `📧 Email: ${formatValue(candidate.customer_email)}\n`;
    report += `🆔 Stripe Customer: ${formatValue(candidate.stripe_customer_id)}\n`;
    report += `🔢 Payment identifier: ${formatValue(candidate.payment_identifier)}\n`;
    report += `💳 Method: ${formatValue(candidate.payment_method_type)}\n`;
    report += `📝 Description: ${formatValue(candidate.description)}\n`;
    report += `🔗 Stripe Charge: ${formatValue(candidate.stripe_charge_id)}\n`;
  });

  report += '\n🔐 This private message contains payment identity data. Do not forward it to public groups.';
  return report;
}

/**
 * Formats a non-approving verification result. The reaction is deliberately
 * paired with an explanation so a failed lookup is not mistaken for an
 * unexplained bot decision. UNCLEAR remains "not confirmed" rather than an
 * accusation of fraud.
 */
function formatVerificationFailureReply(ocrResult, processingId) {
  const verification = ocrResult?.verification || {};
  const reason = verification.reason_code || 'VERIFICATION_NOT_CONFIRMED';
  const isOperationalError = verification.verdict === 'ERROR'
    || reason.startsWith('N8N_')
    || reason.startsWith('PROCESSING_')
    || reason === 'STRIPE_NETWORK_ERROR'
    || reason === 'STRIPE_API_ERROR';
  const isUnclear = verification.verdict === 'UNCLEAR' || isOperationalError;
  const candidateCount = Number.isInteger(verification.candidate_count)
    ? verification.candidate_count
    : null;
  const reasonText = {
    NO_EXACT_MATCH: 'Stripe returned no eligible succeeded payment matching the available screenshot evidence.',
    MULTIPLE_EXACT_MATCHES: 'Stripe returned multiple eligible payments, so the payment could not be uniquely confirmed.',
    MULTIPLE_IDENTITY_RECOVERY_MATCHES: 'Stripe returned multiple possible payments, so the payment could not be uniquely confirmed.',
    MULTIPLE_TRANSACTION_ID_MATCHES: 'The payment identifier matched multiple Stripe records, so no payment was approved.',
    TIMEZONE_BOUNDARY_SINGLE_MATCH: 'Stripe uniquely matched the amount, receipt minute, eligible Cash App payment, and strong identity evidence across a bounded timezone boundary.',
    STRIPE_PAGINATION_LIMIT: 'Stripe search reached its safety limit before a unique payment could be confirmed.',
    STRIPE_DISABLED: 'Stripe verification is disabled for this bot instance.',
    STRIPE_LOOKUP_PENDING: 'Stripe verification did not return a completed result.',
    IMAGE_MATCH_DIFFERENT_STRIPE_CHARGE: 'A previously approved receipt image matched this submission, but Stripe returned a different charge. Automatic approval was blocked because the image evidence conflicts with the new payment record.',
    STRIPE_NETWORK_ERROR: 'Stripe could not be reached; the payment was not approved.',
    STRIPE_API_ERROR: 'Stripe returned an API error; the payment was not approved.',
    N8N_EMPTY_RESPONSE: 'The OCR verification workflow returned no response; the payment was not approved.',
    N8N_INVALID_RESPONSE: 'The OCR verification workflow returned an unsupported response; the payment was not approved.',
    PROCESSING_FAILED: 'The payment pipeline failed before verification completed; the payment was not approved.',
    PROCESSING_QUEUE_FULL: 'The payment could not be queued because the processing queue was full; the payment was not approved.',
  }[reason] || 'Stripe did not return one unique eligible succeeded payment for the submitted evidence.';

  const heading = isUnclear ? '⚠️ *Payment Requires Review*' : '❌ *Payment Not Confirmed*';
  const conclusion = isOperationalError
    ? 'This is not a fraud determination. Verification did not complete, so no payment decision was made. Please retry or review the Stripe record.'
    : isUnclear
      ? 'This is not a fraud determination. No payment was approved because the available evidence did not identify exactly one Stripe record.'
    : 'No payment was approved. Please review the screenshot details and Stripe record.';
  const sameImageNote = verification.same_image_candidate
    ? `\n🖼️ Same image candidate only: ${verification.same_image_original_processing_id || 'previous processing'}${verification.same_image_original_group_name ? ` in ${verification.same_image_original_group_name}` : ''}. Stripe did not prove the same payment, so this was not labelled duplicate.`
    : '';
  const imageConflictNote = reason === 'IMAGE_MATCH_DIFFERENT_STRIPE_CHARGE'
    ? `\n🖼️ Prior matching screenshot: ${verification.image_conflict_original_processing_id || 'previous processing'}\n🔗 Prior Stripe charge: ${verification.image_conflict_original_stripe_charge_id || 'not recorded'}\n🔗 Current Stripe charge: ${verification.stripe_charge_id || 'not recorded'}\nAutomatic approval was blocked because the receipt image conflicts with the current Stripe record.`
    : '';
  const candidateReport = reason === 'MULTIPLE_EXACT_MATCHES'
    || reason === 'MULTIPLE_IDENTITY_RECOVERY_MATCHES'
    || reason === 'MULTIPLE_TRANSACTION_ID_MATCHES'
    ? formatStripeCandidateReview(verification, ocrResult)
    : '';
  const evidence = formatReceiptEvidence(ocrResult);
  const justification = formatReviewJustification(ocrResult, verification);
  return `${heading}\n📋 Processing ID: ${processingId}\n\n${reasonText}\n🧾 Verification reason: ${reason}\n📊 Stripe candidates reviewed: ${candidateCount ?? 'not available'}\n${evidence}\n\n${justification}${sameImageNote}${imageConflictNote}${candidateReport}\n${conclusion}`;
}

/**
 * Formats the only text response intentionally sent by the new reaction-first
 * contract: a duplicate explanation with enough provenance for review.
 */
function formatDuplicateReply(ocrResult, processingId, { groupScope = null, originalGroupName = null } = {}) {
  const verification = ocrResult?.verification || {};
  const normalizedGroupName = typeof originalGroupName === 'string'
    ? originalGroupName.replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';
  const namedScope = normalizedGroupName ? `group "${normalizedGroupName}"` : null;
  const scope = groupScope === 'same_group'
    ? namedScope ? `the same ${namedScope}` : 'the same group'
    : groupScope === 'another_group'
      ? namedScope ? `the ${namedScope}` : 'another group'
      : namedScope || 'this WhatsApp workspace';
  const reason = verification.reason_code || 'DUPLICATE_DETECTED';
  const originalId = verification.duplicate_of_processing_id || 'previous processing';
  const reasonText = reason === 'DUPLICATE_STRIPE_TRANSACTION'
    ? 'the same Stripe transaction was already verified'
    : reason === 'DUPLICATE_IMAGE_PHASH'
      ? 'a visually equivalent copy of the screenshot was already processed'
      : reason === 'DUPLICATE_IMAGE_PHASH_TRANSACTION_ID'
        ? 'a visually equivalent copy with the same payment identifier was already processed'
      : reason === 'DUPLICATE_IMAGE_PHASH_RECEIPT_EVIDENCE'
        ? 'a visually equivalent copy with the same receipt customer, amount, and time evidence was already processed'
      : reason === 'DUPLICATE_IMAGE_PHASH_VISUAL_RECEIPT'
        ? 'a visually equivalent copy with the same receipt amount and time evidence was already processed'
      : reason === 'DUPLICATE_IMAGE_TRANSACTION_EVIDENCE'
        ? 'the same payment-specific receipt evidence was already processed'
      : 'the exact screenshot image was already processed';
  const stripeCharge = verification.stripe_charge_id || verification.matched_transaction?.stripe_charge_id;
  const duplicateProof = verification.duplicate_proof || {};
  const transactionId = duplicateProof.transaction_id || verification.transaction_id;
  const proof = stripeCharge
    ? `\n🔗 Proof: both submissions resolved to Stripe charge ${stripeCharge}.`
    : reason === 'DUPLICATE_IMAGE_SHA256_UNVERIFIED'
      ? `\n🔐 Proof: the downloaded image bytes have the same SHA-256 fingerprint as the original screenshot${duplicateProof.image_sha256 ? ` (${duplicateProof.image_sha256.slice(0, 16)}…)` : ''}. The original attempt was not approved, so this repeat was not approved either.`
      : reason === 'DUPLICATE_IMAGE_PHASH_TRANSACTION_ID'
        ? `\n🔗 Proof: the receipt image is visually equivalent and carries the same payment identifier${transactionId ? ` (${transactionId})` : ''}. Stripe did not return a new canonical charge, so no second approval was recorded.`
        : reason === 'DUPLICATE_IMAGE_PHASH_RECEIPT_EVIDENCE'
          ? '\n🔗 Proof: the receipt image is visually equivalent and carries the same customer, amount, and receipt time evidence. Stripe did not return a new canonical charge, so no second approval was recorded.'
        : reason === 'DUPLICATE_IMAGE_PHASH_VISUAL_RECEIPT'
          ? '\n🔗 Proof: the receipt image has the same strict visual fingerprint and the same amount and complete receipt time. OCR identifier text can vary after image processing, so no second approval was recorded.'
        : reason === 'DUPLICATE_IMAGE_TRANSACTION_EVIDENCE'
          ? `\n🔗 Proof: the stored receipt evidence carries the same payment identifier${transactionId ? ` (${transactionId})` : ''}, amount, and receipt time as the original. No second approval was recorded.`
        : '\n🔗 Proof: the duplicate decision is backed by the stored payment-specific receipt evidence; no second approval was recorded.';

  return `♻️ *Duplicate Screenshot*\n📋 Processing ID: ${processingId}\n\nThis screenshot was already processed in ${scope}; ${reasonText}.\n🧾 Detection reason: ${reason}\n🔁 Original Processing ID: ${originalId}${proof}\n\nThe original screenshot is annotated in its original group when WhatsApp permits cross-group quoting. No second payment verification was recorded.`;
}

/**
 * Formats a generic error message for WhatsApp.
 * @param {string} processingId - The unique processing ID
 * @returns {string} The formatted error message
 */
function formatErrorReply(processingId) {
  return `❌ *Error Processing Screenshot*\n📋 Processing ID: ${processingId}\n\nSorry, an error occurred while processing this image. Please try again later.`;
}

module.exports = {
  formatOcrReply,
  formatStripeCandidateReview,
  formatPrivateStripeCandidateReview,
  formatDuplicateReply,
  formatVerificationFailureReply,
  formatErrorReply,
};

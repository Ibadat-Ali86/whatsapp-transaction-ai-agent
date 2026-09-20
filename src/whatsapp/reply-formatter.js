/**
 * Formats the OCR result into a human-readable WhatsApp message.
 * @param {object} ocrResult - The result from the OCR service
 * @param {string} processingId - The unique processing ID
 * @param {string|null} captionEmail - The normalized WhatsApp caption email
 * @returns {string} The formatted reply message
 */
function formatOcrReply(ocrResult, processingId, captionEmail = null) {
  // The OCR API returns extracted values under `fields`. Accepting the
  // legacy top-level shape as well keeps this formatter backward-compatible.
  const fields = ocrResult?.fields || ocrResult || {};
  const verification = ocrResult?.verification;
  const stripeTransaction = verification?.matched_transaction || {};
  const email = stripeTransaction.customer_email || captionEmail || ocrResult?.caption_email || fields.email || 'Not found';
  const amountCents = stripeTransaction.amount_cents ?? fields.amount_cents;
  const amount = amountCents != null
    ? `$${(amountCents / 100).toFixed(2)}`
    : fields.amount != null ? `$${fields.amount}` : 'Not found';
  const minutes = stripeTransaction.minutes ?? fields.minutes ?? 'Not found';
  const dateStr = stripeTransaction.payment_date || fields.payment_date || fields.date || 'Not found';
  const name = stripeTransaction.customer_name || fields.customer_name || fields.name || 'Not found';
  const description = stripeTransaction.description || fields.description || 'Not found';
  const status = stripeTransaction.status || fields.status || 'Not found';
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
  reply += `📧 Email: ${email}\n`;
  reply += `💰 Amount: ${amount}\n`;
  reply += `⏱ Minutes: ${minutes}\n`;
  reply += `📅 Date: ${dateStr}\n`;
  reply += `👤 Name: ${name}\n`;
  reply += `📝 Description: ${description}\n`;
  reply += `✅ Status: ${status}\n\n`;
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
    if (verification.stripe_charge_id) {
      reply += `🔗 Stripe Charge: ${verification.stripe_charge_id}\n`;
    }
    reply += `\n`;
  }

  if (confidence < 50) {
    reply += `⚠️ Low confidence — manual review recommended\n\n`;
  }

  reply += `⚠️ _Note: This is automated extraction. Verify before acting on financial decisions._`;
  
  return reply;
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
  const isUnclear = verification.verdict === 'UNCLEAR';
  const candidateCount = Number.isInteger(verification.candidate_count)
    ? verification.candidate_count
    : null;
  const reasonText = {
    NO_EXACT_MATCH: 'Stripe returned no eligible succeeded payment matching the available screenshot evidence.',
    MULTIPLE_EXACT_MATCHES: 'Stripe returned multiple eligible payments, so the payment could not be uniquely confirmed.',
    MULTIPLE_IDENTITY_RECOVERY_MATCHES: 'Stripe returned multiple possible payments, so the payment could not be uniquely confirmed.',
    MULTIPLE_TRANSACTION_ID_MATCHES: 'The payment identifier matched multiple Stripe records, so no payment was approved.',
    STRIPE_PAGINATION_LIMIT: 'Stripe search reached its safety limit before a unique payment could be confirmed.',
    STRIPE_DISABLED: 'Stripe verification is disabled for this bot instance.',
    STRIPE_LOOKUP_PENDING: 'Stripe verification did not return a completed result.',
    IMAGE_MATCH_DIFFERENT_STRIPE_CHARGE: 'A previously approved receipt image matched this submission, but Stripe returned a different charge. Automatic approval was blocked because the image evidence conflicts with the new payment record.',
    STRIPE_NETWORK_ERROR: 'Stripe could not be reached; the payment was not approved.',
    STRIPE_API_ERROR: 'Stripe returned an API error; the payment was not approved.',
    PROCESSING_FAILED: 'The payment pipeline failed before verification completed; the payment was not approved.',
    PROCESSING_QUEUE_FULL: 'The payment could not be queued because the processing queue was full; the payment was not approved.',
  }[reason] || 'Stripe did not return one unique eligible succeeded payment for the submitted evidence.';

  const heading = isUnclear ? '⚠️ *Payment Requires Review*' : '❌ *Payment Not Confirmed*';
  const conclusion = isUnclear
    ? 'This is not a fraud determination. No payment was approved because the available evidence did not identify exactly one Stripe record.'
    : 'No payment was approved. Please review the screenshot details and Stripe record.';
  const sameImageNote = verification.same_image_candidate
    ? `\n🖼️ Same image candidate only: ${verification.same_image_original_processing_id || 'previous processing'}${verification.same_image_original_group_name ? ` in ${verification.same_image_original_group_name}` : ''}. Stripe did not prove the same payment, so this was not labelled duplicate.`
    : '';
  const imageConflictNote = reason === 'IMAGE_MATCH_DIFFERENT_STRIPE_CHARGE'
    ? `\n🖼️ Prior matching screenshot: ${verification.image_conflict_original_processing_id || 'previous processing'}\n🔗 Prior Stripe charge: ${verification.image_conflict_original_stripe_charge_id || 'not recorded'}\n🔗 Current Stripe charge: ${verification.stripe_charge_id || 'not recorded'}\nAutomatic approval was blocked because the receipt image conflicts with the current Stripe record.`
    : '';
  return `${heading}\n📋 Processing ID: ${processingId}\n\n${reasonText}\n🧾 Verification reason: ${reason}\n📊 Stripe candidates reviewed: ${candidateCount ?? 'not available'}${sameImageNote}${imageConflictNote}\n\n${conclusion}`;
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
  formatDuplicateReply,
  formatVerificationFailureReply,
  formatErrorReply,
};

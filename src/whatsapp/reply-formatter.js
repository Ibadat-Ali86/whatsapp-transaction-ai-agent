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
  const email = captionEmail || ocrResult?.caption_email || fields.email || 'Not found';
  const amountCents = stripeTransaction.amount_cents ?? fields.amount_cents;
  const amount = amountCents != null
    ? `$${(amountCents / 100).toFixed(2)}`
    : fields.amount != null ? `$${fields.amount}` : 'Not found';
  const minutes = stripeTransaction.minutes ?? fields.minutes ?? 'Not found';
  const dateStr = stripeTransaction.payment_date || fields.payment_date || fields.date || 'Not found';
  const name = stripeTransaction.customer_name || fields.customer_name || fields.name || 'Not found';
  const status = stripeTransaction.status || fields.status || 'Not found';
  const confidence = ocrResult?.confidence != null ? Math.round(ocrResult.confidence * 100) : 0;
  const provider = ocrResult?.provider || 'tesseract';

  let reply = `🔍 *Payment Screenshot Analysis*\n`;
  reply += `📋 Processing ID: ${processingId}\n\n`;
  reply += `📧 Email: ${email}\n`;
  reply += `💰 Amount: ${amount}\n`;
  reply += `⏱ Minutes: ${minutes}\n`;
  reply += `📅 Date: ${dateStr}\n`;
  reply += `👤 Name: ${name}\n`;
  reply += `✅ Status: ${status}\n\n`;

  if (stripeTransaction.payment_time) {
    reply += `🕒 Stripe Payment Time: ${stripeTransaction.payment_time}\n\n`;
  }
  reply += `📊 Confidence: ${confidence}%\n`;
  reply += `🔬 OCR Provider: ${provider}\n\n`;

  if (ocrResult?.fallback_reason === 'AI_PROVIDER_UNAVAILABLE') {
    reply += `⚠️ AI enhancement unavailable — result is from local OCR. Manual review recommended.\n\n`;
  }

  if (verification) {
    const verdict = verification.verdict || 'UNCLEAR';
    const marker = verdict === 'VALID' ? '✅' : verdict === 'ERROR' ? '❌' : '⚠️';
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
 * Formats a generic error message for WhatsApp.
 * @param {string} processingId - The unique processing ID
 * @returns {string} The formatted error message
 */
function formatErrorReply(processingId) {
  return `❌ *Error Processing Screenshot*\n📋 Processing ID: ${processingId}\n\nSorry, an error occurred while processing this image. Please try again later.`;
}

module.exports = { formatOcrReply, formatErrorReply };

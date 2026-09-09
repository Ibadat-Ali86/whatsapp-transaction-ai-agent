/**
 * Formats the OCR result into a human-readable WhatsApp message.
 * @param {object} ocrResult - The result from the OCR service
 * @param {string} processingId - The unique processing ID
 * @returns {string} The formatted reply message
 */
function formatOcrReply(ocrResult, processingId) {
  // The OCR API returns extracted values under `fields`. Accepting the
  // legacy top-level shape as well keeps this formatter backward-compatible.
  const fields = ocrResult?.fields || ocrResult || {};
  const email = fields.email || 'Not found';
  const amount = fields.amount_cents != null
    ? `$${(fields.amount_cents / 100).toFixed(2)}`
    : fields.amount != null ? `$${fields.amount}` : 'Not found';
  const minutes = fields.minutes != null ? fields.minutes : 'Not found';
  const dateStr = fields.payment_date || fields.date || 'Not found';
  const name = fields.customer_name || fields.name || 'Not found';
  const status = fields.status || 'Not found';
  const confidence = ocrResult?.confidence != null ? Math.round(ocrResult.confidence * 100) : 0;
  const provider = ocrResult?.provider || 'tesseract';
  const verification = ocrResult?.verification;

  let reply = `🔍 *Payment Screenshot Analysis*\n`;
  reply += `📋 Processing ID: ${processingId}\n\n`;
  reply += `📧 Email: ${email}\n`;
  reply += `💰 Amount: ${amount}\n`;
  reply += `⏱ Minutes: ${minutes}\n`;
  reply += `📅 Date: ${dateStr}\n`;
  reply += `👤 Name: ${name}\n`;
  reply += `✅ Status: ${status}\n\n`;
  reply += `📊 Confidence: ${confidence}%\n`;
  reply += `🔬 OCR Provider: ${provider}\n\n`;

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

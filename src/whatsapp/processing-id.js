const crypto = require('crypto');

/**
 * Generates a unique processing ID.
 * Format: wa-YYYYMMDD-HHMMSS-<8-random-hex>
 * @returns {string} The processing ID
 */
function generateProcessingId() {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const randomHex = crypto.randomBytes(4).toString('hex');
  return `wa-${dateStr}-${randomHex}`;
}

module.exports = { generateProcessingId };

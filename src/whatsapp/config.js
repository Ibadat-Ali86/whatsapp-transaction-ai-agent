require('dotenv').config();
const { parseAllowedGroupJids } = require('./group-access');

const allowedGroupJids = parseAllowedGroupJids(
  process.env.WHATSAPP_ALLOWED_GROUP_JIDS,
  process.env.WHATSAPP_TEST_GROUP_JID
);

const config = {
  OCR_SERVICE_URL: process.env.OCR_SERVICE_URL || 'http://localhost:8000',
  ALLOWED_GROUP_JIDS: allowedGroupJids,
  WHATSAPP_TEST_GROUP_JID: process.env.WHATSAPP_TEST_GROUP_JID || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  AUTH_DIR: process.env.AUTH_DIR || 'auth',
  TEMP_DIR: process.env.TEMP_DIR || 'tmp',
  OCR_TIMEOUT_MS: parseInt(process.env.OCR_TIMEOUT_MS || '60000', 10),
  MAX_IMAGE_SIZE_MB: parseInt(process.env.MAX_IMAGE_SIZE_MB || '10', 10),
  BOT_REPLY_ENABLED: process.env.BOT_REPLY_ENABLED !== 'false',
};

if (!config.ALLOWED_GROUP_JIDS.length) {
  console.error('ERROR: No WhatsApp groups are allowlisted. Message processing is fail-closed until WHATSAPP_ALLOWED_GROUP_JIDS is configured.');
}

module.exports = Object.freeze(config);

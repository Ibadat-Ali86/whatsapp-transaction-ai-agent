require('dotenv').config();
const { parseAllowedGroupJids } = require('./group-access');

const allowedGroupJids = parseAllowedGroupJids(
  process.env.WHATSAPP_ALLOWED_GROUP_JIDS,
  process.env.WHATSAPP_TEST_GROUP_JID
);

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  OCR_SERVICE_URL: process.env.OCR_SERVICE_URL || 'http://localhost:8000',
  N8N_ENABLED: process.env.N8N_ENABLED === 'true',
  N8N_BASE_URL: process.env.N8N_BASE_URL || 'http://localhost:5678',
  N8N_WEBHOOK_PATH: process.env.N8N_WEBHOOK_PATH || '/webhook/whatsapp-screenshot',
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',
  N8N_WEBHOOK_TOKEN: process.env.N8N_WEBHOOK_TOKEN || '',
  N8N_TIMEOUT_MS: parseInteger(process.env.N8N_TIMEOUT_MS, 60000),
  N8N_RETRY_ATTEMPTS: parseInteger(process.env.N8N_RETRY_ATTEMPTS, 2),
  REQUIRE_EMAIL_CAPTION: process.env.REQUIRE_EMAIL_CAPTION !== 'false',
  ALLOWED_GROUP_JIDS: allowedGroupJids,
  WHATSAPP_TEST_GROUP_JID: process.env.WHATSAPP_TEST_GROUP_JID || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  AUTH_DIR: process.env.AUTH_DIR || 'auth',
  TEMP_DIR: process.env.TEMP_DIR || 'tmp',
  OCR_TIMEOUT_MS: parseInteger(process.env.OCR_TIMEOUT_MS, 60000),
  MAX_IMAGE_SIZE_MB: parseInteger(process.env.MAX_IMAGE_SIZE_MB, 10),
  BOT_REPLY_ENABLED: process.env.BOT_REPLY_ENABLED !== 'false',
};

if (!config.ALLOWED_GROUP_JIDS.length) {
  console.error('ERROR: No WhatsApp groups are allowlisted. Message processing is fail-closed until WHATSAPP_ALLOWED_GROUP_JIDS is configured.');
}

module.exports = Object.freeze(config);

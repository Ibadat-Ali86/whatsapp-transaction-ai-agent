require('dotenv').config();

const config = {
  OCR_SERVICE_URL: process.env.OCR_SERVICE_URL || 'http://localhost:8000',
  WHATSAPP_TEST_GROUP_JID: process.env.WHATSAPP_TEST_GROUP_JID || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  AUTH_DIR: process.env.AUTH_DIR || 'auth',
  TEMP_DIR: process.env.TEMP_DIR || 'tmp',
  OCR_TIMEOUT_MS: parseInt(process.env.OCR_TIMEOUT_MS || '60000', 10),
  MAX_IMAGE_SIZE_MB: parseInt(process.env.MAX_IMAGE_SIZE_MB || '10', 10),
  BOT_REPLY_ENABLED: process.env.BOT_REPLY_ENABLED !== 'false',
};

if (!config.WHATSAPP_TEST_GROUP_JID) {
  console.warn('WARNING: WHATSAPP_TEST_GROUP_JID is not set in environment variables. Running in unrestricted mode or may not process messages depending on handler.');
}

module.exports = Object.freeze(config);

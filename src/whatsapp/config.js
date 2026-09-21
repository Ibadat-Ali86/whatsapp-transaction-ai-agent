require('dotenv').config();
const { parseAllowedGroupJids, parsePrivateReviewJids } = require('./group-access');

const allowedGroupJids = parseAllowedGroupJids(
  process.env.WHATSAPP_ALLOWED_GROUP_JIDS,
  process.env.WHATSAPP_TEST_GROUP_JID
);
const privateReviewJids = parsePrivateReviewJids(process.env.PAYMENT_REVIEW_ADMIN_JIDS);

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const config = {
  OCR_SERVICE_URL: process.env.OCR_SERVICE_URL || 'http://localhost:8000',
  N8N_ENABLED: process.env.N8N_ENABLED === 'true',
  N8N_BASE_URL: process.env.N8N_BASE_URL || 'http://localhost:5678',
  N8N_WEBHOOK_PATH: process.env.N8N_WEBHOOK_PATH || '/webhook/whatsapp-screenshot',
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',
  N8N_WEBHOOK_TOKEN: process.env.N8N_WEBHOOK_TOKEN || '',
  N8N_HEALTH_TIMEOUT_MS: parseInteger(process.env.N8N_HEALTH_TIMEOUT_MS, 5000),
  N8N_TIMEOUT_MS: parseInteger(process.env.N8N_TIMEOUT_MS, 60000),
  N8N_RETRY_ATTEMPTS: parseInteger(process.env.N8N_RETRY_ATTEMPTS, 2),
  STRIPE_VERIFICATION_ENABLED: process.env.STRIPE_VERIFICATION_ENABLED === 'true',
  STRIPE_TIMEZONE: process.env.STRIPE_TIMEZONE || 'UTC',
  REQUIRE_EMAIL_CAPTION: process.env.REQUIRE_EMAIL_CAPTION !== 'false',
  ALLOWED_GROUP_JIDS: allowedGroupJids,
  PAYMENT_REVIEW_ADMIN_JIDS: privateReviewJids,
  WHATSAPP_TEST_GROUP_JID: process.env.WHATSAPP_TEST_GROUP_JID || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  BOT_LOCK_PATH: process.env.BOT_LOCK_PATH || 'data/whatsapp-bot.lock',
  AUTH_DIR: process.env.AUTH_DIR || 'auth',
  RESET_GROUP_SENDER_KEYS_ON_START: process.env.RESET_GROUP_SENDER_KEYS_ON_START !== 'false',
  TEMP_DIR: process.env.TEMP_DIR || 'tmp',
  CAPTION_ASSOCIATION_WINDOW_MS: parseInteger(process.env.CAPTION_ASSOCIATION_WINDOW_MS, 2000),
  DUPLICATE_STORE_PATH: process.env.DUPLICATE_STORE_PATH || 'data/duplicate-store.json',
  DUPLICATE_RETENTION_DAYS: parseInteger(process.env.DUPLICATE_RETENTION_DAYS, 90),
  DUPLICATE_PHASH_MAX_DISTANCE: parseInteger(process.env.DUPLICATE_PHASH_MAX_DISTANCE, 6),
  PROCESSING_QUEUE_PATH: process.env.PROCESSING_QUEUE_PATH || 'data/processing-queue.json',
  PROCESSING_QUEUE_CONCURRENCY: parseInteger(process.env.PROCESSING_QUEUE_CONCURRENCY, 1),
  PROCESSING_QUEUE_MAX_PENDING: parseInteger(process.env.PROCESSING_QUEUE_MAX_PENDING, 200),
  PROCESSING_QUEUE_MAX_ATTEMPTS: parseInteger(process.env.PROCESSING_QUEUE_MAX_ATTEMPTS, 4),
  PROCESSING_QUEUE_BACKOFF_BASE_MS: parseInteger(process.env.PROCESSING_QUEUE_BACKOFF_BASE_MS, 5000),
  PROCESSING_QUEUE_BACKOFF_MAX_MS: parseInteger(process.env.PROCESSING_QUEUE_BACKOFF_MAX_MS, 300000),
  PROCESSING_QUEUE_COOLDOWN_MS: parseNonNegativeInteger(process.env.PROCESSING_QUEUE_COOLDOWN_MS, 250),
  OCR_TIMEOUT_MS: parseInteger(process.env.OCR_TIMEOUT_MS, 60000),
  MAX_IMAGE_SIZE_MB: parseInteger(process.env.MAX_IMAGE_SIZE_MB, 10),
  BOT_REPLY_ENABLED: process.env.BOT_REPLY_ENABLED !== 'false',
  BOT_REACTIONS_ENABLED: process.env.BOT_REACTIONS_ENABLED !== 'false',
};

if (!config.ALLOWED_GROUP_JIDS.length) {
  console.error('ERROR: No WhatsApp groups are allowlisted. Message processing is fail-closed until WHATSAPP_ALLOWED_GROUP_JIDS is configured.');
}

module.exports = Object.freeze(config);

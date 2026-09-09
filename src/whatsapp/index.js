require('dotenv').config();
const config = require('./config');
const { logger } = require('./logger');
const { createConnection } = require('./connection');
const { createMessageHandler } = require('./message-handler');
const { checkOcrServiceHealth } = require('./ocr-client');

/**
 * Main entry point for the WhatsApp bot.
 */
async function main() {
  console.log(`
=========================================
WhatsApp Transaction AI Agent v1.0.0
OCR Service: ${config.OCR_SERVICE_URL}
Test Group: ${config.WHATSAPP_TEST_GROUP_JID ? 'configured' : 'not configured'}
Auth Dir: ${config.AUTH_DIR}/
=========================================
`);

  logger.info('Starting WhatsApp Transaction AI Agent...');
  
  const ocrReady = await checkOcrServiceHealth();
  if (!ocrReady) {
    logger.warn('OCR service is not currently ready or reachable. Continuing anyway...');
  } else {
    logger.info('OCR service is ready.');
  }

  const sock = await createConnection();
  const messageHandler = createMessageHandler(sock, config, logger);

  sock.ev.on('messages.upsert', messageHandler);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Graceful shutdown initiated');
    try {
      sock.ws.close();
      logger.info('WhatsApp socket closed.');
    } catch (err) {
      logger.error({ err }, 'Error closing socket');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});

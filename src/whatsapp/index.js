require('dotenv').config();
const config = require('./config');
const { logger } = require('./logger');
const { createConnection } = require('./connection');
const { createMessageHandler } = require('./message-handler');
const { checkOcrServiceHealth } = require('./ocr-client');
const { checkN8nServiceHealth } = require('./n8n-client');

/**
 * Main entry point for the WhatsApp bot.
 */
async function main() {
  console.log(`
=========================================
WhatsApp Transaction AI Agent v1.0.0
OCR Service: ${config.OCR_SERVICE_URL}
Allowed Groups: ${config.ALLOWED_GROUP_JIDS.length}
Auth Dir: ${config.AUTH_DIR}/
=========================================
`);

  logger.info('Starting WhatsApp Transaction AI Agent...');
  
  const ocrReady = await checkOcrServiceHealth();
  if (!ocrReady) {
    if (config.N8N_ENABLED) {
      logger.error(
        { ocrServiceUrl: config.OCR_SERVICE_URL },
        'n8n mode requires the OCR service; start the OCR service before starting the WhatsApp bot',
      );
      process.exitCode = 1;
      return;
    }
    logger.warn('OCR service is not currently ready or reachable. Continuing anyway...');
  } else {
    logger.info('OCR service is ready.');
  }

  if (config.N8N_ENABLED) {
    if (!config.N8N_WEBHOOK_TOKEN) {
      logger.error('n8n is enabled but N8N_WEBHOOK_TOKEN is missing; configure the webhook credential before starting the WhatsApp bot');
      process.exitCode = 1;
      return;
    }
    const n8nReady = await checkN8nServiceHealth({ config });
    if (!n8nReady) {
      logger.error(
        { n8nBaseUrl: config.N8N_BASE_URL },
        'n8n is enabled but the service is not reachable; start n8n and activate the workflow before starting the WhatsApp bot',
      );
      process.exitCode = 1;
      return;
    }
    logger.info('n8n service is ready.');
  }

  // Keep one queue/handler across Baileys socket replacements. Recreating the
  // handler on reconnect would create a second worker and could process the
  // same durable queue concurrently.
  const socketRef = { current: null };
  const handler = createMessageHandler(null, config, logger, {
    getSock: () => socketRef.current,
  });
  const connection = await createConnection({
    onSocket: (sock) => {
      socketRef.current = sock;
      sock.ev.on('messages.upsert', handler);
      handler.start();
    },
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Graceful shutdown initiated');
    try {
      handler.stop();
      connection.stop();
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

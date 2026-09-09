const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const { logger } = require('./logger');
const config = require('./config');

/**
 * Creates and manages the Baileys WhatsApp connection
 * @returns {Promise<any>} The socket instance
 */
async function createConnection() {
  const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: logger.child({ module: 'baileys' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      logger.info('QR Code generated. Scan it to authenticate.');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error;
      const statusCode = (error instanceof Boom) ? error.output?.statusCode : error?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      
      logger.info({ reason: statusCode, shouldReconnect: !isLoggedOut }, 'Connection closed');
      
      if (!isLoggedOut) {
        setTimeout(() => {
          logger.info('Reconnecting...');
          createConnection();
        }, Math.min(Math.pow(2, 2) * 1000 + 3000, 60000));
      } else {
        logger.warn('Logged out from WhatsApp. Need to rescan QR code. Auth state is not deleted automatically.');
      }
    } else if (connection === 'open') {
      logger.info('WhatsApp connection opened successfully.');
    }
  });

  return sock;
}

module.exports = { createConnection };

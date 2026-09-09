const { generateProcessingId } = require('./processing-id');
const { downloadImage, MediaDownloadError } = require('./media-downloader');
const { processImageOCR, OcrServiceError } = require('./ocr-client');
const { formatOcrReply, formatErrorReply } = require('./reply-formatter');
const fs = require('fs').promises;
const crypto = require('crypto');

/**
 * Orchestrates the processing of incoming WhatsApp messages.
 * @param {any} sock - Baileys socket
 * @param {object} config - Configuration object
 * @param {any} logger - Pino logger instance
 * @returns {function} Message handler function
 */
function createMessageHandler(sock, config, logger) {
  return async (messageUpdate) => {
    try {
      const messages = messageUpdate.messages;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        
        const isImage = !!(msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);
        if (!isImage) continue;

        const groupId = msg.key.remoteJid;
        if (config.WHATSAPP_TEST_GROUP_JID && groupId !== config.WHATSAPP_TEST_GROUP_JID) {
          continue;
        }

        const processingId = generateProcessingId();
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const hashedJid = crypto.createHash('sha256').update(senderJid).digest('hex').substring(0, 10);
        
        const mimeType = msg.message.imageMessage?.mimetype || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.mimetype || 'unknown';
        logger.info({ processingId, messageId: msg.key.id, groupId, senderJid: hashedJid, mimeType }, 'Incoming image message');

        let tempPath = null;
        const startTime = Date.now();

        try {
          const { imageBytes, mimeType: downloadedMime, tempPath: tp } = await downloadImage(msg, processingId);
          tempPath = tp;
          
          const imageBase64 = imageBytes.toString('base64');
          
          const ocrResult = await processImageOCR({
            imageBase64,
            mimeType: downloadedMime,
            processingId,
            messageId: msg.key.id,
            groupId,
            senderJid
          });
          
          const replyText = formatOcrReply(ocrResult, processingId);
          
          if (config.BOT_REPLY_ENABLED) {
            await sock.sendMessage(groupId, { text: replyText }, { quoted: msg });
          }
          
          logger.info({ processingId, duration_ms: Date.now() - startTime, verdict: 'success' }, 'Message processing complete');
        } catch (error) {
          if (error instanceof MediaDownloadError) {
            logger.error({ processingId, err: error }, 'Media download error');
            if (config.BOT_REPLY_ENABLED) {
              await sock.sendMessage(groupId, { text: `❌ *Download Error*\n📋 Processing ID: ${processingId}\n\nCould not download the image.` }, { quoted: msg });
            }
          } else if (error instanceof OcrServiceError) {
            logger.error({ processingId, err: error }, 'OCR service error');
            if (config.BOT_REPLY_ENABLED) {
              await sock.sendMessage(groupId, { text: `❌ *Service Unavailable*\n📋 Processing ID: ${processingId}\n\nOCR service is currently unavailable.` }, { quoted: msg });
            }
          } else {
            logger.error({ processingId, err: error, stack: error.stack }, 'Unhandled error processing message');
            if (config.BOT_REPLY_ENABLED) {
              await sock.sendMessage(groupId, { text: formatErrorReply(processingId) }, { quoted: msg });
            }
          }
        } finally {
          if (tempPath) {
            try {
              await fs.unlink(tempPath);
              logger.debug({ processingId, tempPath }, 'Temporary file deleted');
            } catch (err) {
              logger.error({ processingId, tempPath, err }, 'Failed to delete temporary file');
            }
          }
        }
      }
    } catch (globalError) {
      logger.error({ err: globalError }, 'Message handler crashed');
    }
  };
}

module.exports = { createMessageHandler };

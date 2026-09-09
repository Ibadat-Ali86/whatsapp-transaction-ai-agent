const { generateProcessingId } = require('./processing-id');
const { downloadImage, MediaDownloadError } = require('./media-downloader');
const { processImageOCR, OcrServiceError } = require('./ocr-client');
const { formatOcrReply, formatErrorReply } = require('./reply-formatter');
const { getImageCaption, normalizeCaptionEmail } = require('./caption-email');
const { createIdempotencyStore } = require('./idempotency-store');
const { processImageViaN8n, N8nServiceError } = require('./n8n-client');
const fs = require('fs').promises;
const crypto = require('crypto');
const { isAllowedGroupJid, hashGroupJid } = require('./group-access');

/**
 * Orchestrates the processing of incoming WhatsApp messages.
 * @param {any} sock - Baileys socket
 * @param {object} config - Configuration object
 * @param {any} logger - Pino logger instance
 * @returns {function} Message handler function
 */
function createMessageHandler(sock, config, logger, dependencies = {}) {
  const downloadImageFn = dependencies.downloadImage || downloadImage;
  const processImageOCRFn = dependencies.processImageOCR || processImageOCR;
  const processImageViaN8nFn = dependencies.processImageViaN8n || processImageViaN8n;
  const idempotencyStore = dependencies.idempotencyStore || createIdempotencyStore();

  return async (messageUpdate) => {
    try {
      const messages = messageUpdate?.messages || [];
      for (const msg of messages) {
        const groupId = msg.key?.remoteJid;
        if (!isAllowedGroupJid(groupId, config.ALLOWED_GROUP_JIDS)) {
          logger.debug({ groupIdHash: hashGroupJid(groupId) }, 'Ignoring message outside the WhatsApp group allowlist');
          continue;
        }

        if (!msg.message || msg.key?.fromMe) continue;

        const isImage = !!(msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);
        if (!isImage) continue;

        const messageId = msg.key?.id;
        const idempotencyKey = `${groupId || 'unknown'}:${messageId || 'unknown'}`;
        if (!idempotencyStore.claim(idempotencyKey)) {
          logger.debug({ messageId, groupIdHash: hashGroupJid(groupId) }, 'Skipping duplicate WhatsApp message');
          continue;
        }

        const caption = getImageCaption(msg);
        const captionEmail = normalizeCaptionEmail(caption);
        if (config.REQUIRE_EMAIL_CAPTION !== false && !captionEmail) {
          logger.warn({ messageId, groupIdHash: hashGroupJid(groupId) }, 'Ignoring image without a valid email caption');
          if (config.BOT_REPLY_ENABLED) {
            await sock.sendMessage(
              groupId,
              { text: '⚠️ *Caption required*\nPlease resend the payment screenshot with the customer email as the caption.' },
              { quoted: msg },
            );
          }
          idempotencyStore.complete(idempotencyKey);
          continue;
        }

        const processingId = generateProcessingId();
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const hashedJid = crypto.createHash('sha256').update(senderJid).digest('hex').substring(0, 10);
        
        const mimeType = msg.message.imageMessage?.mimetype || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.mimetype || 'unknown';
        logger.info({ processingId, messageId, groupIdHash: hashGroupJid(groupId), senderJid: hashedJid, mimeType }, 'Incoming image message');

        let tempPath = null;
        let processingSucceeded = false;
        const startTime = Date.now();

        try {
          const { imageBytes, mimeType: downloadedMime, tempPath: tp } = await downloadImageFn(sock, msg, processingId);
          tempPath = tp;
          
          const imageBase64 = imageBytes.toString('base64');

          const eventPayload = {
            processing_id: processingId,
            source: 'whatsapp',
            message_id: messageId,
            group_id: groupId,
            sender_jid: senderJid,
            received_at: new Date().toISOString(),
            is_forwarded: Boolean(msg.message?.imageMessage?.contextInfo?.isForwarded),
            caption_email: captionEmail,
            stripe_verification_enabled: config.STRIPE_VERIFICATION_ENABLED === true,
            image: {
              mime_type: downloadedMime,
              base64: imageBase64,
            },
          };

          const ocrResult = config.N8N_ENABLED
            ? await processImageViaN8nFn(eventPayload)
            : await processImageOCRFn({
            imageBase64,
            mimeType: downloadedMime,
            processingId,
            messageId,
            groupId,
            senderJid,
            captionEmail,
          });
          
          const replyText = formatOcrReply(ocrResult, processingId);
          
          if (config.BOT_REPLY_ENABLED) {
            await sock.sendMessage(groupId, { text: replyText }, { quoted: msg });
          }
          
          logger.info({ processingId, duration_ms: Date.now() - startTime, verdict: 'success' }, 'Message processing complete');
          idempotencyStore.complete(idempotencyKey);
          processingSucceeded = true;
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
          } else if (error instanceof N8nServiceError) {
            logger.error({ processingId, retryable: error.retryable }, 'n8n workflow service error');
            if (config.BOT_REPLY_ENABLED) {
              await sock.sendMessage(groupId, { text: `❌ *Workflow Unavailable*\n📋 Processing ID: ${processingId}\n\nThe processing workflow is currently unavailable.` }, { quoted: msg });
            }
          } else {
            logger.error({ processingId, err: error, stack: error.stack }, 'Unhandled error processing message');
            if (config.BOT_REPLY_ENABLED) {
              await sock.sendMessage(groupId, { text: formatErrorReply(processingId) }, { quoted: msg });
            }
          }
          // A failed delivery may be retried; concurrent duplicate deliveries
          // remain suppressed while the first attempt is active.
          if (!processingSucceeded) idempotencyStore.release(idempotencyKey);
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

const { generateProcessingId } = require('./processing-id');
const { downloadImage, MediaDownloadError } = require('./media-downloader');
const { processImageOCR, OcrServiceError } = require('./ocr-client');
const { formatOcrReply, formatDuplicateReply } = require('./reply-formatter');
const { getImageCaption, normalizeCaptionEmail } = require('./caption-email');
const { createIdempotencyStore } = require('./idempotency-store');
const { processImageViaN8n, N8nServiceError } = require('./n8n-client');
const fs = require('fs').promises;
const crypto = require('crypto');
const { isAllowedGroupJid, hashGroupJid } = require('./group-access');
const { createDuplicateStore } = require('./duplicate-store');

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
  const duplicateStore = dependencies.duplicateStore || createDuplicateStore({
    filePath: config.DUPLICATE_STORE_PATH,
    ttlMs: (config.DUPLICATE_RETENTION_DAYS || 90) * 24 * 60 * 60 * 1000,
    phashMaxDistance: config.DUPLICATE_PHASH_MAX_DISTANCE || 6,
  });
  const groupNameCache = new Map();
  const resolveGroupName = dependencies.getGroupName || (async groupId => {
    if (!groupId) return null;
    if (groupNameCache.has(groupId)) return groupNameCache.get(groupId);
    try {
      const metadata = await sock.groupMetadata(groupId);
      const subject = typeof metadata?.subject === 'string' ? metadata.subject.trim() : '';
      const groupName = subject ? subject.replace(/\s+/g, ' ').slice(0, 120) : null;
      groupNameCache.set(groupId, groupName);
      return groupName;
    } catch (error) {
      logger.debug({ groupIdHash: hashGroupJid(groupId), err: error }, 'Unable to resolve WhatsApp group name for duplicate provenance');
      groupNameCache.set(groupId, null);
      return null;
    }
  });
  const groupHash = groupId => hashGroupJid(groupId);
  const sendReaction = async (groupId, msg, text) => {
    if (config.BOT_REACTIONS_ENABLED === false) return;
    await sock.sendMessage(groupId, { react: { text, key: msg.key } });
  };
  const duplicateScope = (record, groupId) => record?.group_id_hash === groupHash(groupId) ? 'same_group' : 'another_group';

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
        const groupName = await resolveGroupName(groupId);
        if (!captionEmail) logger.info({ messageId, groupIdHash: groupHash(groupId) }, 'No valid caption email; continuing with OCR and Stripe evidence recovery');

        const processingId = generateProcessingId();
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const hashedJid = crypto.createHash('sha256').update(senderJid).digest('hex').substring(0, 10);
        
        const mimeType = msg.message.imageMessage?.mimetype || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.mimetype || 'unknown';
        logger.info({ processingId, messageId, groupIdHash: hashGroupJid(groupId), senderJid: hashedJid, mimeType }, 'Incoming image message');

        let tempPath = null;
        let processingSucceeded = false;
        let imageHash = null;
        let imageClaimed = false;
        const startTime = Date.now();

        try {
          const { imageBytes, mimeType: downloadedMime, tempPath: tp } = await downloadImageFn(sock, msg, processingId);
          tempPath = tp;

          imageHash = crypto.createHash('sha256').update(imageBytes).digest('hex');
          const imageClaim = duplicateStore.claimImage({
            sha256: imageHash,
            processingId,
            groupIdHash: hashGroupJid(groupId),
            groupName,
            captionEmail,
          });
          if (imageClaim.duplicate) {
            const duplicateResult = {
              provider: 'duplicate-detector',
              confidence: 1,
              fields: { email: captionEmail },
              verification: {
                status: 'DUPLICATE',
                verdict: 'DUPLICATE',
                reason_code: `DUPLICATE_IMAGE_${imageClaim.matchType}`,
                duplicate_of_processing_id: imageClaim.record.processing_id,
                duplicate_scope: duplicateScope(imageClaim.record, groupId),
              },
            };
            if (config.BOT_REPLY_ENABLED) {
              await sock.sendMessage(groupId, {
                text: formatDuplicateReply(duplicateResult, processingId, {
                  groupScope: duplicateScope(imageClaim.record, groupId),
                  originalGroupName: imageClaim.record.group_name,
                }),
              }, { quoted: msg });
            }
            logger.info({ processingId, groupIdHash: hashGroupJid(groupId), matchType: imageClaim.matchType }, 'Duplicate image detected');
            idempotencyStore.complete(idempotencyKey);
            processingSucceeded = true;
            continue;
          }
          imageClaimed = true;
          
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
          
          const fields = ocrResult?.fields || {};
          const imageEvidence = duplicateStore.registerImageEvidence({
            sha256: imageHash,
            phash: ocrResult?.image_phash,
            captionEmail,
            amountCents: fields.amount_cents,
            processingId,
          });
          let finalResult = ocrResult;
          if (imageEvidence.duplicate) {
            finalResult = {
              ...ocrResult,
              verification: {
                ...(ocrResult.verification || {}),
                status: 'DUPLICATE',
                verdict: 'DUPLICATE',
                reason_code: `DUPLICATE_IMAGE_${imageEvidence.matchType}`,
                duplicate_of_processing_id: imageEvidence.record.processing_id,
                duplicate_scope: duplicateScope(imageEvidence.record, groupId),
                duplicate_group_name: imageEvidence.record.group_name,
              },
            };
          } else if (ocrResult?.verification?.verdict === 'VALID' && ocrResult.verification.stripe_charge_id) {
            const transactionKey = `stripe:${ocrResult.verification.stripe_charge_id}`;
            const transactionClaim = duplicateStore.claimTransaction(transactionKey, {
              processingId,
              groupIdHash: hashGroupJid(groupId),
              groupName,
            });
            if (transactionClaim.duplicate) {
              finalResult = {
                ...ocrResult,
                verification: {
                  ...ocrResult.verification,
                  status: 'DUPLICATE',
                  verdict: 'DUPLICATE',
                  reason_code: 'DUPLICATE_STRIPE_TRANSACTION',
                  duplicate_of_processing_id: transactionClaim.record.processing_id,
                  duplicate_scope: duplicateScope(transactionClaim.record, groupId),
                  duplicate_group_name: transactionClaim.record.group_name,
                },
              };
            }
          }

          if (finalResult?.verification?.verdict === 'DUPLICATE') {
            if (config.BOT_REPLY_ENABLED) {
              await sock.sendMessage(groupId, {
                text: formatDuplicateReply(finalResult, processingId, {
                  groupScope: finalResult.verification.duplicate_scope,
                  originalGroupName: finalResult.verification.duplicate_group_name,
                }),
              }, { quoted: msg });
            }
          } else if (finalResult?.verification?.verdict === 'VALID' && !captionEmail) {
            // A captionless match needs an auditable reply so the group can
            // see which Stripe customer identity was recovered. Keep the
            // reaction as the primary status marker as with other outcomes.
            if (config.BOT_REPLY_ENABLED) {
              await sock.sendMessage(groupId, {
                text: formatOcrReply(finalResult, processingId, null),
              }, { quoted: msg });
            }
            await sendReaction(groupId, msg, '✅');
          } else {
            const verdict = finalResult?.verification?.verdict;
            await sendReaction(
              groupId,
              msg,
              verdict === 'VALID' ? '✅' : verdict === 'UNCLEAR' || !verdict ? '⚠️' : '❌',
            );
          }
          
          logger.info({ processingId, duration_ms: Date.now() - startTime, verdict: 'success' }, 'Message processing complete');
          idempotencyStore.complete(idempotencyKey);
          processingSucceeded = true;
        } catch (error) {
          if (error instanceof MediaDownloadError) {
            logger.error({ processingId, err: error }, 'Media download error');
            await sendReaction(groupId, msg, '❌');
          } else if (error instanceof OcrServiceError) {
            logger.error({ processingId, err: error }, 'OCR service error');
            await sendReaction(groupId, msg, '❌');
          } else if (error instanceof N8nServiceError) {
            logger.error({
              processingId,
              retryable: error.retryable,
              status: error.status,
              code: error.code,
            }, 'n8n workflow service error');
            await sendReaction(groupId, msg, '❌');
          } else {
            logger.error({ processingId, err: error, stack: error.stack }, 'Unhandled error processing message');
            await sendReaction(groupId, msg, '❌');
          }
          // A failed delivery may be retried; concurrent duplicate deliveries
          // remain suppressed while the first attempt is active.
          if (!processingSucceeded) idempotencyStore.release(idempotencyKey);
          if (!processingSucceeded && imageClaimed && imageHash) duplicateStore.releaseImage(imageHash);
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

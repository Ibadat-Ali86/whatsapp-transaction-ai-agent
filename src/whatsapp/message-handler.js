const { generateProcessingId } = require('./processing-id');
const { downloadImage } = require('./media-downloader');
const { processImageOCR } = require('./ocr-client');
const {
  formatOcrReply,
  formatDuplicateReply,
  formatVerificationFailureReply,
} = require('./reply-formatter');
const { getImageCaption, getStandaloneTextEmail, normalizeCaptionEmail } = require('./caption-email');
const { createIdempotencyStore } = require('./idempotency-store');
const { processImageViaN8n } = require('./n8n-client');
const fs = require('fs').promises;
const crypto = require('crypto');
const { isAllowedGroupJid, hashGroupJid } = require('./group-access');
const { createDuplicateStore } = require('./duplicate-store');
const { createProcessingQueue, QueueFullError } = require('./processing-queue');

/**
 * Orchestrates WhatsApp intake and delegates expensive work to a durable,
 * single-worker queue. The queue is deliberately created outside the
 * messages.upsert callback so bursts from many groups cannot run pipelines in
 * parallel.
 */
function createMessageHandler(sock, config, logger, dependencies = {}) {
  const getSock = dependencies.getSock || (() => sock);
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
  const pendingCaptionEmails = new Map();
  const MAX_PENDING_CAPTION_KEYS = 4096;
  const captionAssociationWindowMs = Number.isInteger(config.CAPTION_ASSOCIATION_WINDOW_MS)
    ? config.CAPTION_ASSOCIATION_WINDOW_MS
    : 2000;
  let messageSequence = 0;

  const senderKey = message => message?.key?.participant || message?.key?.participantAlt || '';
  const captionKey = (groupId, message) => `${groupId || ''}:${senderKey(message)}`;
  const cleanupPendingCaptionEmails = () => {
    const cutoff = Date.now() - captionAssociationWindowMs;
    for (const [key, candidates] of pendingCaptionEmails) {
      const activeCandidates = candidates.filter(candidate => candidate.receivedAt >= cutoff);
      if (activeCandidates.length) pendingCaptionEmails.set(key, activeCandidates);
      else pendingCaptionEmails.delete(key);
    }
    while (pendingCaptionEmails.size > MAX_PENDING_CAPTION_KEYS) {
      let oldestKey = null;
      let oldestReceivedAt = Infinity;
      for (const [key, candidates] of pendingCaptionEmails) {
        const lastReceivedAt = candidates[candidates.length - 1]?.receivedAt || 0;
        if (lastReceivedAt < oldestReceivedAt) {
          oldestKey = key;
          oldestReceivedAt = lastReceivedAt;
        }
      }
      if (oldestKey === null) break;
      pendingCaptionEmails.delete(oldestKey);
    }
  };
  const rememberStandaloneEmail = (groupId, message, sequence) => {
    if (message?.key?.fromMe || !senderKey(message)) return;
    const email = getStandaloneTextEmail(message);
    if (!email) return;
    cleanupPendingCaptionEmails();
    const key = captionKey(groupId, message);
    const cutoff = Date.now() - captionAssociationWindowMs;
    const candidates = (pendingCaptionEmails.get(key) || [])
      .filter(candidate => candidate.receivedAt >= cutoff);
    candidates.push({ email, sequence, receivedAt: Date.now() });
    pendingCaptionEmails.set(key, candidates.slice(-8));
  };
  const waitForFollowUpCaption = ms => ms > 0
    ? new Promise(resolve => setTimeout(resolve, ms))
    : Promise.resolve();
  const takeAssociatedEmail = (groupId, message, imageSequence, imageReceivedAt) => {
    const key = captionKey(groupId, message);
    const candidates = pendingCaptionEmails.get(key) || [];
    const eligible = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => (
        candidate.sequence !== imageSequence
        && Math.abs(candidate.receivedAt - imageReceivedAt) <= captionAssociationWindowMs
      ))
      .sort((left, right) => {
        const timeDistance = Math.abs(left.candidate.receivedAt - imageReceivedAt)
          - Math.abs(right.candidate.receivedAt - imageReceivedAt);
        return timeDistance || Math.abs(left.candidate.sequence - imageSequence)
          - Math.abs(right.candidate.sequence - imageSequence);
      });
    if (!eligible.length) {
      const cutoff = Date.now() - captionAssociationWindowMs;
      pendingCaptionEmails.set(key, candidates.filter(candidate => candidate.receivedAt >= cutoff));
      return null;
    }
    const [{ candidate: match, index }] = eligible;
    candidates.splice(index, 1);
    if (candidates.length) pendingCaptionEmails.set(key, candidates);
    else pendingCaptionEmails.delete(key);
    return match.email;
  };

  const groupHash = groupId => hashGroupJid(groupId);
  const duplicateScope = (record, groupId) => record?.group_id_hash === groupHash(groupId) ? 'same_group' : 'another_group';

  const sendReaction = async (groupId, message, text) => {
    if (config.BOT_REACTIONS_ENABLED === false) return;
    const currentSock = getSock();
    if (!currentSock) {
      const error = new Error('WhatsApp socket is unavailable');
      error.retryable = true;
      throw error;
    }
    await currentSock.sendMessage(groupId, { react: { text, key: message.key } });
  };

  const resolveGroupName = dependencies.getGroupName || (async groupId => {
    if (!groupId) return null;
    if (groupNameCache.has(groupId)) return groupNameCache.get(groupId);
    try {
      const currentSock = getSock();
      if (!currentSock) return null;
      const metadata = await currentSock.groupMetadata(groupId);
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

  const processJob = async job => {
    let tempPath = null;
    let imageHash = null;
    const groupId = job.group_id;
    const message = job.message;
    const startTime = Date.now();

    try {
      const currentSock = getSock();
      if (!currentSock) {
        const error = new Error('WhatsApp socket is unavailable');
        error.retryable = true;
        throw error;
      }

      const { imageBytes, mimeType: downloadedMime, tempPath: downloadedPath } = await downloadImageFn(currentSock, message, job.processing_id);
      tempPath = downloadedPath;
      imageHash = crypto.createHash('sha256').update(imageBytes).digest('hex');

      const imageClaim = duplicateStore.claimImage({
        sha256: imageHash,
        processingId: job.processing_id,
        groupIdHash: hashGroupJid(groupId),
        groupName: job.group_name,
        captionEmail: job.caption_email,
      });
      if (imageClaim.duplicate) {
        const duplicateResult = {
          provider: 'duplicate-detector',
          confidence: 1,
          fields: { email: job.caption_email },
          verification: {
            status: 'DUPLICATE',
            verdict: 'DUPLICATE',
            reason_code: `DUPLICATE_IMAGE_${imageClaim.matchType}`,
            duplicate_of_processing_id: imageClaim.record.processing_id,
            duplicate_scope: duplicateScope(imageClaim.record, groupId),
          },
        };
        if (config.BOT_REPLY_ENABLED) {
          await currentSock.sendMessage(groupId, {
            text: formatDuplicateReply(duplicateResult, job.processing_id, {
              groupScope: duplicateScope(imageClaim.record, groupId),
              originalGroupName: imageClaim.record.group_name,
            }),
          }, { quoted: message });
        }
        logger.info({ processingId: job.processing_id, groupIdHash: hashGroupJid(groupId), matchType: imageClaim.matchType }, 'Duplicate image detected');
        return { status: 'COMPLETED', verdict: 'DUPLICATE', processing_id: job.processing_id };
      }

      const imageBase64 = imageBytes.toString('base64');
      const eventPayload = {
        processing_id: job.processing_id,
        source: 'whatsapp',
        message_id: job.message_id,
        group_id: groupId,
        sender_jid: job.sender_jid,
        received_at: job.received_at,
        is_forwarded: Boolean(job.is_forwarded),
        caption_email: job.caption_email,
        stripe_verification_enabled: config.STRIPE_VERIFICATION_ENABLED === true,
        stripe_timezone: config.STRIPE_TIMEZONE,
        image: { mime_type: downloadedMime, base64: imageBase64 },
      };

      const ocrResult = config.N8N_ENABLED
        ? await processImageViaN8nFn(eventPayload)
        : await processImageOCRFn({
          imageBase64,
          mimeType: downloadedMime,
          processingId: job.processing_id,
          messageId: job.message_id,
          groupId,
          senderJid: job.sender_jid,
          captionEmail: job.caption_email,
        });

      const fields = ocrResult?.fields || {};
      const imageEvidence = duplicateStore.registerImageEvidence({
        sha256: imageHash,
        phash: ocrResult?.image_phash,
        captionEmail: job.caption_email,
        amountCents: fields.amount_cents,
        processingId: job.processing_id,
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
        const transactionClaim = duplicateStore.claimTransaction(`stripe:${ocrResult.verification.stripe_charge_id}`, {
          processingId: job.processing_id,
          groupIdHash: hashGroupJid(groupId),
          groupName: job.group_name,
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
          await currentSock.sendMessage(groupId, {
            text: formatDuplicateReply(finalResult, job.processing_id, {
              groupScope: finalResult.verification.duplicate_scope,
              originalGroupName: finalResult.verification.duplicate_group_name,
            }),
          }, { quoted: message });
        }
      } else if (finalResult?.verification?.verdict === 'VALID') {
        const verification = finalResult.verification || {};
        const canonicalEmail = verification.matched_transaction?.customer_email;
        const captionEmail = job.caption_email?.toLowerCase();
        const identityWasRecovered = verification.reason_code === 'IDENTITY_RECOVERED_FROM_STRIPE'
          || (canonicalEmail && captionEmail && canonicalEmail.toLowerCase() !== captionEmail);
        if (config.BOT_REPLY_ENABLED && (!job.caption_email || identityWasRecovered)) {
          await currentSock.sendMessage(groupId, {
            text: formatOcrReply(finalResult, job.processing_id, job.caption_email || null),
          }, { quoted: message });
        }
        await sendReaction(groupId, message, '✅');
      } else {
        const verdict = finalResult?.verification?.verdict;
        if (config.BOT_REPLY_ENABLED && verdict !== 'VALID') {
          await currentSock.sendMessage(groupId, {
            text: formatVerificationFailureReply(finalResult, job.processing_id),
          }, { quoted: message });
        }
        await sendReaction(groupId, message, verdict === 'VALID' ? '✅' : '❌');
      }

      const verification = finalResult?.verification || {};
      logger.info({
        processingId: job.processing_id,
        duration_ms: Date.now() - startTime,
        verdict: verification.verdict || 'UNVERIFIED',
        verification_status: verification.status || null,
        verification_reason: verification.reason_code || null,
        verification_candidate_count: Number.isInteger(verification.candidate_count) ? verification.candidate_count : null,
        stripe_charge_id: verification.stripe_charge_id || null,
      }, 'Message processing complete');
      return { status: 'COMPLETED', verdict: finalResult?.verification?.verdict || 'UNVERIFIED', processing_id: job.processing_id };
    } catch (error) {
      if (imageHash && error?.retryable !== true) error.imageHash = imageHash;
      logger.error({ processingId: job.processing_id, retryable: error?.retryable === true, errorType: error?.name || 'Error', errorCode: error?.code || null, err: error }, 'Queued screenshot processing failed');
      throw error;
    } finally {
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
          logger.debug({ processingId: job.processing_id, tempPath }, 'Temporary file deleted');
        } catch (error) {
          logger.error({ processingId: job.processing_id, tempPath, err: error }, 'Failed to delete temporary file');
        }
      }
    }
  };

  const onDeadLetter = async (job, error) => {
    logger.error({ processingId: job.processing_id, attempts: job.attempts, errorType: error?.name || 'Error', errorCode: error?.code || null }, 'Screenshot moved to dead-letter review');
    if (error?.imageHash) duplicateStore.releaseImage(error.imageHash);
    try {
      if (config.BOT_REPLY_ENABLED) {
        await getSock().sendMessage(job.group_id, {
          text: formatVerificationFailureReply({
            verification: {
              verdict: 'ERROR',
              reason_code: error?.code || 'PROCESSING_FAILED',
            },
          }, job.processing_id),
        }, { quoted: { key: job.message_key } });
      }
      await sendReaction(job.group_id, { key: job.message_key }, '❌');
    } catch (notificationError) {
      logger.error({ processingId: job.processing_id, err: notificationError }, 'Unable to send dead-letter reaction');
    }
  };

  const queue = dependencies.processingQueue || createProcessingQueue({
    filePath: config.PROCESSING_QUEUE_PATH || null,
    concurrency: config.PROCESSING_QUEUE_CONCURRENCY || 1,
    maxPending: config.PROCESSING_QUEUE_MAX_PENDING || 200,
    maxAttempts: config.PROCESSING_QUEUE_MAX_ATTEMPTS || 4,
    backoffBaseMs: config.PROCESSING_QUEUE_BACKOFF_BASE_MS || 5000,
    backoffMaxMs: config.PROCESSING_QUEUE_BACKOFF_MAX_MS || 300000,
    cooldownMs: config.PROCESSING_QUEUE_COOLDOWN_MS ?? 250,
    worker: processJob,
    onDeadLetter,
    logger,
  });

  const handler = async messageUpdate => {
    try {
      const messages = messageUpdate?.messages || [];
      cleanupPendingCaptionEmails();
      const messageSequences = new Map();
      for (const msg of messages) {
        const sequence = ++messageSequence;
        if (msg.key?.id) messageSequences.set(msg.key.id, sequence);
        const groupId = msg.key?.remoteJid;
        if (isAllowedGroupJid(groupId, config.ALLOWED_GROUP_JIDS)) {
          rememberStandaloneEmail(groupId, msg, sequence);
        }
      }
      const intakePromises = messages.map(async msg => {
        const groupId = msg.key?.remoteJid;
        if (!isAllowedGroupJid(groupId, config.ALLOWED_GROUP_JIDS)) {
          logger.debug({ groupIdHash: hashGroupJid(groupId) }, 'Ignoring message outside the WhatsApp group allowlist');
          return;
        }
        if (!msg.message || msg.key?.fromMe) return;
        const isImage = !!(msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);
        if (!isImage) return;

        const messageId = msg.key?.id;
        const idempotencyKey = `${groupId || 'unknown'}:${messageId || 'unknown'}`;
        if (!idempotencyStore.claim(idempotencyKey)) {
          logger.debug({ messageId, groupIdHash: hashGroupJid(groupId) }, 'Skipping duplicate WhatsApp message');
          return;
        }

        const captionEmail = normalizeCaptionEmail(getImageCaption(msg));
        let effectiveCaptionEmail = captionEmail;
        if (!effectiveCaptionEmail) {
          const imageReceivedAt = Date.now();
          await waitForFollowUpCaption(captionAssociationWindowMs);
          effectiveCaptionEmail = takeAssociatedEmail(
            groupId,
            msg,
            messageSequences.get(messageId) || 0,
            imageReceivedAt,
          );
          if (effectiveCaptionEmail) {
            logger.info({ messageId, groupIdHash: groupHash(groupId) }, 'Associated a nearby same-sender email message with the screenshot');
          }
        }
        const groupName = await resolveGroupName(groupId);
        if (!effectiveCaptionEmail) logger.info({ messageId, groupIdHash: groupHash(groupId) }, 'No valid caption email; continuing with OCR and Stripe evidence recovery');

        const processingId = generateProcessingId();
        const senderJid = senderKey(msg) || msg.key.remoteJid;
        const hashedJid = crypto.createHash('sha256').update(senderJid).digest('hex').substring(0, 10);
        const mimeType = msg.message.imageMessage?.mimetype || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.mimetype || 'unknown';
        logger.info({ processingId, messageId, groupIdHash: hashGroupJid(groupId), senderJid: hashedJid, mimeType, queueDepth: queue.pendingCount }, 'Incoming image queued');

        const job = {
          processing_id: processingId,
          idempotency_key: idempotencyKey,
          message_id: messageId,
          message_key: msg.key,
          message: msg,
          group_id: groupId,
          group_name: groupName,
          sender_jid: senderJid,
          received_at: new Date().toISOString(),
          is_forwarded: Boolean(msg.message?.imageMessage?.contextInfo?.isForwarded),
          caption_email: effectiveCaptionEmail,
        };

        try {
          await queue.enqueue(job);
          idempotencyStore.complete(idempotencyKey);
        } catch (error) {
          idempotencyStore.release(idempotencyKey);
          if (error instanceof QueueFullError) {
            logger.error({ processingId, queueDepth: queue.pendingCount }, 'Screenshot rejected because processing queue is full');
            try {
              if (config.BOT_REPLY_ENABLED) {
                await getSock().sendMessage(groupId, {
                  text: formatVerificationFailureReply({
                    verification: {
                      verdict: 'ERROR',
                      reason_code: 'PROCESSING_QUEUE_FULL',
                    },
                  }, processingId),
                }, { quoted: msg });
              }
              await sendReaction(groupId, msg, '❌');
            } catch (notificationError) {
              logger.error({ processingId, err: notificationError }, 'Unable to send queue-full reaction');
            }
            return;
          }
          throw error;
        }
      });
      await Promise.all(intakePromises);
    } catch (globalError) {
      logger.error({ err: globalError }, 'Message intake handler crashed');
    }
  };

  handler.start = () => queue.start();
  handler.stop = () => queue.stop();
  handler.queue = queue;
  return handler;
}

module.exports = { createMessageHandler };

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { logger } = require('./logger');

class MediaDownloadError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = 'MediaDownloadError';
    this.retryable = retryable;
  }
}

/**
 * Downloads image media from a WhatsApp message.
 * @param {object} message - The WhatsApp message object
 * @param {string} processingId - The unique processing ID
 * @returns {Promise<{imageBytes: Buffer, mimeType: string, tempPath: string}>}
 */
async function downloadImage(message, processingId) {
  const mimeType = message.message?.imageMessage?.mimetype || message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.mimetype || '';
  
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new MediaDownloadError(`Invalid mime type: ${mimeType}`);
  }

  const fileLength = message.message?.imageMessage?.fileLength || message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.fileLength || 0;
  
  if (fileLength > config.MAX_IMAGE_SIZE_MB * 1024 * 1024) {
    throw new MediaDownloadError(`File size exceeds maximum allowed (${config.MAX_IMAGE_SIZE_MB}MB)`);
  }

  logger.info({ processingId, mimeType, size: fileLength }, 'Starting image download');

  try {
    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      { logger: logger.child({ module: 'baileys-download' }), reuploadRequest: () => {} }
    );
    
    await fs.mkdir(config.TEMP_DIR, { recursive: true });
    
    const ext = mimeType.split('/')[1] || 'jpg';
    const tempPath = path.join(config.TEMP_DIR, `${processingId}.${ext}`);
    
    await fs.writeFile(tempPath, buffer);
    logger.info({ processingId, tempPath }, 'Image download complete');
    
    return { imageBytes: buffer, mimeType, tempPath };
  } catch (error) {
    logger.error({ processingId, err: error }, 'Failed to download media');
    throw new MediaDownloadError('Failed to download media message', true);
  }
}

module.exports = { downloadImage, MediaDownloadError };

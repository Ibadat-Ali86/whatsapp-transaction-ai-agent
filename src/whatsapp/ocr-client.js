const axios = require('axios');
const config = require('./config');
const { logger } = require('./logger');
const { hashGroupJid } = require('./group-access');

class OcrServiceError extends Error {
  constructor(message, retryable = false, detail = null) {
    super(message);
    this.name = 'OcrServiceError';
    this.retryable = retryable;
    this.detail = detail;
  }
}

/**
 * Calls the Python OCR service to process an image.
 * @param {object} params - The OCR parameters
 * @param {number} retries - Number of retries left
 * @returns {Promise<any>} The OCR result
 */
async function processImageOCR(params, retries = 2) {
  const {
    imageBase64,
    mimeType,
    processingId,
    messageId,
    groupId,
    senderJid,
    captionEmail,
    excludedStripeChargeIds,
  } = params;
  
  const startTime = Date.now();
  logger.info({ processingId, messageId, groupIdHash: hashGroupJid(groupId), senderJid: String(senderJid || '').substring(0, 10) + '...' }, 'Sending request to OCR service');

  try {
    const response = await axios.post(`${config.OCR_SERVICE_URL}/api/v1/ocr/process`, {
      image_base64: imageBase64,
      mime_type: mimeType,
      processing_id: processingId,
      message_id: messageId,
      group_id: groupId,
      sender_jid: senderJid,
      caption_email: captionEmail || null,
      excluded_stripe_charge_ids: Array.isArray(excludedStripeChargeIds)
        ? excludedStripeChargeIds
        : [],
    }, {
      timeout: config.OCR_TIMEOUT_MS
    });

    logger.info({ processingId, duration_ms: Date.now() - startTime }, 'Received response from OCR service');
    return response.data;
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      if (status >= 400 && status < 500) {
        throw new OcrServiceError(`OCR Service Client Error: ${status}`, false, error.response.data);
      } else {
        if (retries > 0) {
          logger.warn({ processingId, retryLeft: retries - 1 }, 'OCR Service 5xx Error, retrying...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          return processImageOCR(params, retries - 1);
        }
        throw new OcrServiceError(`OCR Service Server Error: ${status}`, true, error.response.data);
      }
    } else {
      if (retries > 0) {
        logger.warn({ processingId, retryLeft: retries - 1 }, 'OCR Service Network Error, retrying...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        return processImageOCR(params, retries - 1);
      }
      throw new OcrServiceError(`OCR Service Network Error: ${error.message}`, true);
    }
  }
}

/**
 * Checks the health of the OCR service.
 * @returns {Promise<boolean>} True if ready
 */
async function checkOcrServiceHealth() {
  try {
    const response = await axios.get(`${config.OCR_SERVICE_URL}/health/ready`);
    return response.data?.status === 'ok' || response.data?.status === 'degraded';
  } catch (error) {
    return false;
  }
}

module.exports = { processImageOCR, checkOcrServiceHealth, OcrServiceError };

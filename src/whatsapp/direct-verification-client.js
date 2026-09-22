const axios = require('axios');
const config = require('./config');
const { processImageOCR } = require('./ocr-client');

const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/;

class DirectVerificationError extends Error {
  constructor(message, retryable = false, details = {}) {
    super(message);
    this.name = 'DirectVerificationError';
    this.retryable = retryable;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
  }
}

function validEmail(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

function integerEvidence(value, minimum, maximum) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function boundedString(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function parseAmountCents(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/,/g, '').trim();
  const match = normalized.match(/^(\d+(?:\.\d{1,2})?)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return null;
  return Math.round(amount * 100);
}

function rawTextEvidence(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return {};
  const evidence = {};

  const amountMatch = rawText.match(/\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/);
  if (amountMatch) evidence.amount_cents = parseAmountCents(amountMatch[1]);

  const timeMatch = rawText.match(/(?:today|payment|processed|at)[^\n]{0,32}?\b(\d{1,2}):([0-5]\d)\s*([ap]m)?\b/i);
  if (timeMatch) {
    const rawHour = Number(timeMatch[1]);
    const meridiem = (timeMatch[3] || '').toUpperCase();
    if (meridiem && rawHour >= 1 && rawHour <= 12) {
      evidence.payment_hour = meridiem === 'AM'
        ? (rawHour === 12 ? 0 : rawHour)
        : (rawHour === 12 ? 12 : rawHour + 12);
    } else if (!meridiem && rawHour >= 0 && rawHour <= 23) {
      evidence.payment_hour = rawHour;
    }
    evidence.minutes = Number(timeMatch[2]);
  }

  const dateMatch = rawText.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b/i);
  if (dateMatch) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(dateMatch[0].slice(0, 3).toLowerCase()) + 1;
    if (month >= 1 && month <= 12) {
      evidence.payment_month = month;
      evidence.payment_day = Number(dateMatch[1]);
    }
  }

  return evidence;
}

function normalizedFields(ocrResult) {
  const fields = ocrResult?.fields && typeof ocrResult.fields === 'object'
    ? { ...ocrResult.fields }
    : {};
  const fallback = rawTextEvidence(ocrResult?.raw_text);
  for (const [key, value] of Object.entries(fallback)) {
    if (fields[key] === null || fields[key] === undefined || fields[key] === '') fields[key] = value;
  }
  return fields;
}

function buildStripeVerificationRequest({ ocrResult, job, excludedStripeChargeIds = [] }) {
  const fields = normalizedFields(ocrResult);
  const captionEmail = validEmail(job?.caption_email);
  const ocrEmail = validEmail(fields.email);
  const emailCandidates = [...new Set([captionEmail, ocrEmail].filter(Boolean))].slice(0, 8);
  const paymentDate = validDate(fields.payment_date);
  const transactionId = boundedString(fields.transaction_id, 128);
  const normalizedTransactionId = transactionId && TRANSACTION_ID_PATTERN.test(transactionId)
    ? transactionId
    : null;
  const rawText = typeof ocrResult?.raw_text === 'string' ? ocrResult.raw_text : '';
  const excluded = Array.isArray(excludedStripeChargeIds)
    ? [...new Set(excludedStripeChargeIds.filter(value => typeof value === 'string' && TRANSACTION_ID_PATTERN.test(value.trim())).map(value => value.trim()))].slice(0, 2048)
    : [];

  return {
    processing_id: job.processing_id,
    email: captionEmail || ocrEmail || null,
    email_candidates: emailCandidates,
    transaction_id: normalizedTransactionId,
    description: boundedString(fields.description, 1000),
    customer_name: boundedString(fields.customer_name, 256),
    amount_cents: integerEvidence(fields.amount_cents, 1, 100_000_000),
    payment_date: paymentDate,
    payment_month: integerEvidence(fields.payment_month, 1, 12),
    payment_day: integerEvidence(fields.payment_day, 1, 31),
    minutes: integerEvidence(fields.minutes, 0, 59),
    payment_hour: integerEvidence(fields.payment_hour, 0, 23),
    relative_today: !paymentDate && /\btoday\b/i.test(rawText),
    received_at: job.received_at || null,
    currency: 'usd',
    payment_method_type: 'cashapp',
    excluded_stripe_charge_ids: excluded,
  };
}

async function verifyStripeEvidenceDirect(params, options = {}) {
  const clientConfig = options.config || config;
  const httpClient = options.httpClient || axios;
  const logger = options.logger || { warn() {}, error() {} };
  const serviceToken = clientConfig.STRIPE_SERVICE_TOKEN || '';
  if (!serviceToken) {
    throw new DirectVerificationError(
      'Direct OCR/Stripe fallback is not configured',
      true,
      { code: 'DIRECT_FALLBACK_NOT_CONFIGURED' },
    );
  }

  const stripeRequest = buildStripeVerificationRequest({
    ocrResult: params.ocrResult,
    job: {
      processing_id: params.processingId,
      caption_email: params.captionEmail,
      received_at: params.receivedAt,
    },
    excludedStripeChargeIds: params.excludedStripeChargeIds,
  });

  try {
    const response = await httpClient.post(verificationUrl(clientConfig), stripeRequest, {
      timeout: clientConfig.STRIPE_DIRECT_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        'x-internal-service-token': serviceToken,
      },
    });
    if (!response || response.status < 200 || response.status >= 300) {
      const retryable = !response?.status || response.status >= 500 || response.status === 429;
      throw new DirectVerificationError(
        `Direct Stripe verification failed (${response?.status || 'network'})`,
        retryable,
        { status: response?.status ?? null, code: retryable ? 'DIRECT_STRIPE_RETRYABLE' : 'DIRECT_STRIPE_HTTP_ERROR' },
      );
    }
    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
      throw new DirectVerificationError('Direct Stripe verifier returned an invalid response', true, {
        code: 'DIRECT_STRIPE_INVALID_RESPONSE',
      });
    }
    logger.warn({ processingId: params.processingId }, 'Used direct Stripe evidence recovery after incomplete n8n verification');
    return { ...(params.ocrResult || {}), verification: response.data };
  } catch (error) {
    if (error instanceof DirectVerificationError) throw error;
    const status = error?.response?.status ?? null;
    const retryable = !status || status >= 500 || status === 429;
    throw new DirectVerificationError(
      `Direct Stripe verification failed (${status || 'network'})`,
      retryable,
      {
        status,
        code: error?.code || (retryable ? 'DIRECT_STRIPE_NETWORK_ERROR' : 'DIRECT_STRIPE_HTTP_ERROR'),
      },
    );
  }
}

function verificationUrl(clientConfig) {
  return new URL('/api/v1/verification/stripe', clientConfig.OCR_SERVICE_URL).toString();
}

/**
 * Narrow failover for a retryable n8n transport failure. OCR and Stripe still
 * run in the private services; screenshot text alone can never approve.
 */
async function processImageDirectFallback(params, options = {}) {
  const clientConfig = options.config || config;
  const httpClient = options.httpClient || axios;
  const logger = options.logger || { warn() {}, error() {} };
  const processImageOCRFn = options.processImageOCR || processImageOCR;
  const serviceToken = clientConfig.STRIPE_SERVICE_TOKEN || '';
  if (!serviceToken) {
    throw new DirectVerificationError(
      'Direct OCR/Stripe fallback is not configured',
      true,
      { code: 'DIRECT_FALLBACK_NOT_CONFIGURED' },
    );
  }

  const ocrResult = await processImageOCRFn({
    imageBase64: params.imageBase64,
    mimeType: params.mimeType,
    processingId: params.processingId,
    messageId: params.messageId,
    groupId: params.groupId,
    senderJid: params.senderJid,
    captionEmail: params.captionEmail,
    excludedStripeChargeIds: params.excludedStripeChargeIds,
  });
  return verifyStripeEvidenceDirect({
    ocrResult,
    processingId: params.processingId,
    captionEmail: params.captionEmail,
    receivedAt: params.receivedAt,
    excludedStripeChargeIds: params.excludedStripeChargeIds,
  }, { config: clientConfig, httpClient, logger });
}

module.exports = {
  DirectVerificationError,
  buildStripeVerificationRequest,
  verifyStripeEvidenceDirect,
  processImageDirectFallback,
};

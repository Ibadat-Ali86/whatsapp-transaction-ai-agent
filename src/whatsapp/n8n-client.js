const axios = require('axios');
const config = require('./config');

class N8nServiceError extends Error {
  constructor(message, retryable = false, details = {}) {
    super(message);
    this.name = 'N8nServiceError';
    this.retryable = retryable;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.causeCode = details.causeCode ?? null;
    this.timeoutMs = details.timeoutMs ?? null;
  }
}

function responseType(value) {
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function responseKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).slice(0, 20)
    : [];
}

function hasVerificationDecision(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.status === 'string'
    && (typeof value.verdict === 'string' || typeof value.reason_code === 'string');
}

function isOcrResult(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'fields')
    && (value.fields === null || (typeof value.fields === 'object' && !Array.isArray(value.fields)))
    && (typeof value.provider === 'string' || typeof value.raw_text === 'string' || typeof value.confidence === 'number');
}

/**
 * n8n can return a Respond to Webhook payload directly, as a single item,
 * or wrapped in an item.json/body/data envelope depending on the node and
 * n8n version. Accept only those known envelopes and a recognizable
 * verification result. Never pass an arbitrary object through as a result.
 */
function normalizeN8nResponse(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return normalizeN8nResponse(JSON.parse(trimmed), depth + 1);
    } catch (_error) {
      return null;
    }
  }

  if (Array.isArray(value)) {
    return value.length === 1 ? normalizeN8nResponse(value[0], depth + 1) : null;
  }

  if (typeof value !== 'object') return null;
  if (hasVerificationDecision(value)) return value;

  if (Object.prototype.hasOwnProperty.call(value, 'verification')) {
    const verification = normalizeN8nResponse(value.verification, depth + 1);
    if (hasVerificationDecision(verification)) return { ...value, verification };
  }

  if (isOcrResult(value)) return value;

  for (const key of ['json', 'body', 'data', 'ocr_result', 'verification_result']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const normalized = normalizeN8nResponse(value[key], depth + 1);
      if (normalized) return normalized;
    }
  }
  return null;
}

function isEmptyResponse(value) {
  return value === null
    || value === undefined
    || (typeof value === 'string' && value.trim().length === 0);
}

function buildWebhookUrl(clientConfig) {
  if (clientConfig.N8N_WEBHOOK_URL) return clientConfig.N8N_WEBHOOK_URL;
  return new URL(clientConfig.N8N_WEBHOOK_PATH, clientConfig.N8N_BASE_URL).toString();
}

function isRetryableError(error) {
  const status = error?.response?.status;
  return !status || status >= 500 || status === 429;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildHealthUrl(clientConfig) {
  const baseUrl = clientConfig.N8N_BASE_URL || 'http://localhost:5678';
  return new URL('/healthz', baseUrl).toString();
}

async function checkN8nServiceHealth(options = {}) {
  const clientConfig = options.config || {};
  const httpClient = options.httpClient || axios;
  const timeout = Number.isInteger(clientConfig.N8N_HEALTH_TIMEOUT_MS)
    ? clientConfig.N8N_HEALTH_TIMEOUT_MS
    : 5000;

  try {
    const response = await httpClient.get(buildHealthUrl(clientConfig), { timeout });
    return Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
  } catch (_error) {
    return false;
  }
}

async function processImageViaN8n(payload, options = {}) {
  const clientConfig = options.config || config;
  const httpClient = options.httpClient || axios;
  const logger = options.logger || { warn() {}, error() {} };
  const retryAttempts = Number.isInteger(clientConfig.N8N_RETRY_ATTEMPTS)
    ? clientConfig.N8N_RETRY_ATTEMPTS
    : 2;
  const url = buildWebhookUrl(clientConfig);

  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    try {
      const headers = { 'content-type': 'application/json' };
      if (clientConfig.N8N_WEBHOOK_TOKEN) {
        headers['x-webhook-token'] = clientConfig.N8N_WEBHOOK_TOKEN;
      }

      const response = await httpClient.post(url, payload, {
        timeout: clientConfig.N8N_TIMEOUT_MS,
        headers,
      });

      const normalized = normalizeN8nResponse(response?.data);
      if (!normalized) {
        const empty = isEmptyResponse(response?.data);
        const code = empty ? 'N8N_EMPTY_RESPONSE' : 'N8N_INVALID_RESPONSE';
        logger.warn({
          attempt,
          status: response?.status ?? null,
          content_type: response?.headers?.['content-type'] || response?.headers?.['Content-Type'] || null,
          response_type: responseType(response?.data),
          response_keys: responseKeys(response?.data),
          error_code: code,
        }, 'n8n webhook returned an unsupported response shape');
        throw new N8nServiceError(
          empty ? 'n8n returned an empty response' : 'n8n returned an invalid response',
          empty,
          { status: response?.status ?? null, code },
        );
      }
      (logger.info || (() => {}))({
        status: response?.status ?? null,
        response_kind: Array.isArray(normalized) ? 'array' : typeof normalized,
        ocr_provider: typeof normalized.provider === 'string' ? normalized.provider : null,
        ocr_fields_present: Object.prototype.hasOwnProperty.call(normalized, 'fields'),
        ocr_field_keys: normalized.fields && typeof normalized.fields === 'object'
          ? Object.keys(normalized.fields).filter(key => normalized.fields[key] != null).slice(0, 16)
          : [],
        verification_present: Boolean(normalized.verification || hasVerificationDecision(normalized)),
        verification_reason: normalized.verification?.reason_code || normalized.reason_code || null,
      }, 'n8n webhook response normalized');
      return normalized;
    } catch (error) {
      const retryable = error instanceof N8nServiceError
        ? error.retryable
        : isRetryableError(error);

      if (!retryable || attempt === retryAttempts) {
        if (error instanceof N8nServiceError) throw error;
        const status = error?.response?.status || 'network';
        const code = error?.code || error?.cause?.code || null;
        throw new N8nServiceError(
          `n8n webhook request failed (${status})`,
          retryable,
          {
            status: error?.response?.status ?? null,
            code,
            causeCode: error?.cause?.code ?? null,
            timeoutMs: clientConfig.N8N_TIMEOUT_MS ?? null,
          },
        );
      }

      logger.warn({
        attempt,
        retry_in_ms: 1000,
        status: error?.response?.status ?? null,
        error_code: error?.code || error?.cause?.code || null,
        timeout_ms: clientConfig.N8N_TIMEOUT_MS ?? null,
      }, 'n8n webhook request failed; retrying');
      await wait(1000);
    }
  }

  throw new N8nServiceError('n8n webhook request failed', true);
}

module.exports = {
  processImageViaN8n,
  checkN8nServiceHealth,
  N8nServiceError,
  buildWebhookUrl,
  normalizeN8nResponse,
};

const axios = require('axios');
const config = require('./config');

class N8nServiceError extends Error {
  constructor(message, retryable = false, details = {}) {
    super(message);
    this.name = 'N8nServiceError';
    this.retryable = retryable;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
  }
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

      if (!response?.data || typeof response.data !== 'object') {
        throw new N8nServiceError('n8n returned an invalid response', false);
      }
      return response.data;
    } catch (error) {
      const retryable = error instanceof N8nServiceError
        ? error.retryable
        : isRetryableError(error);

      if (!retryable || attempt === retryAttempts) {
        if (error instanceof N8nServiceError) throw error;
        const status = error?.response?.status || 'network';
        throw new N8nServiceError(
          `n8n webhook request failed (${status})`,
          retryable,
          { status: error?.response?.status ?? null, code: error?.code ?? null },
        );
      }

      logger.warn({ attempt, retry_in_ms: 1000 }, 'n8n webhook request failed; retrying');
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
};

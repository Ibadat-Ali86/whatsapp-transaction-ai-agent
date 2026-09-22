const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWebhookUrl,
  checkN8nServiceHealth,
  processImageViaN8n,
  normalizeN8nResponse,
} = require('../../../src/whatsapp/n8n-client');

test('builds the configured n8n webhook URL', () => {
  assert.equal(
    buildWebhookUrl({ N8N_BASE_URL: 'http://localhost:5678', N8N_WEBHOOK_PATH: '/webhook/test', N8N_WEBHOOK_URL: '' }),
    'http://localhost:5678/webhook/test',
  );
});

test('sends an authenticated event without logging or changing the payload', async () => {
  let request;
  const payload = { processing_id: 'wa-test', caption_email: 'customer@example.com', image: { base64: 'synthetic' } };
  const result = await processImageViaN8n(payload, {
    config: {
      N8N_BASE_URL: 'http://localhost:5678',
      N8N_WEBHOOK_PATH: '/webhook/test',
      N8N_WEBHOOK_URL: '',
      N8N_WEBHOOK_TOKEN: 'test-token',
      N8N_TIMEOUT_MS: 1000,
      N8N_RETRY_ATTEMPTS: 0,
    },
    httpClient: {
      post: async (url, body, options) => {
        request = { url, body, options };
        return { data: { provider: 'tesseract', confidence: 1 } };
      },
    },
  });

  assert.deepEqual(result, { provider: 'tesseract', confidence: 1 });
  assert.equal(request.url, 'http://localhost:5678/webhook/test');
  assert.equal(request.body, payload);
  assert.equal(request.options.headers['x-webhook-token'], 'test-token');
});

test('normalizes supported n8n webhook response envelopes', () => {
  const result = { provider: 'tesseract', fields: { amount_cents: 1000 } };
  assert.deepEqual(normalizeN8nResponse(result), result);
  assert.deepEqual(normalizeN8nResponse([result]), result);
  assert.deepEqual(normalizeN8nResponse([{ json: result }]), result);
  assert.deepEqual(normalizeN8nResponse({ body: { data: JSON.stringify(result) } }), result);
  assert.equal(normalizeN8nResponse([{ json: { unrelated: true } }]), null);
  assert.equal(normalizeN8nResponse([result, result]), null);
});

test('reports a non-empty unsupported n8n response without retrying or approving it', async () => {
  const warnings = [];
  await assert.rejects(
    processImageViaN8n({ processing_id: 'wa-invalid-response' }, {
      config: {
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_WEBHOOK_PATH: '/webhook/test',
        N8N_RETRY_ATTEMPTS: 3,
      },
      httpClient: { post: async () => ({ status: 200, data: { html: '<html>login</html>' } }) },
      logger: { warn: entry => warnings.push(entry) },
    }),
    error => error.code === 'N8N_INVALID_RESPONSE' && error.retryable === false,
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].response_type, 'object');
});

test('retries an empty n8n response and reports the bounded failure code', async () => {
  let attempts = 0;
  await assert.rejects(
    processImageViaN8n({ processing_id: 'wa-empty-response' }, {
      config: {
        N8N_BASE_URL: 'http://localhost:5678',
        N8N_WEBHOOK_PATH: '/webhook/test',
        N8N_RETRY_ATTEMPTS: 1,
      },
      httpClient: { post: async () => { attempts += 1; return { status: 200, data: '' }; } },
      logger: { warn() {} },
    }),
    error => error.code === 'N8N_EMPTY_RESPONSE' && error.retryable === true,
  );
  assert.equal(attempts, 2);
});

test('checks n8n health without sending webhook credentials', async () => {
  let request;
  const ready = await checkN8nServiceHealth({
    config: { N8N_BASE_URL: 'http://localhost:5678', N8N_HEALTH_TIMEOUT_MS: 1000 },
    httpClient: {
      get: async (url, options) => {
        request = { url, options };
        return { status: 200 };
      },
    },
  });

  assert.equal(ready, true);
  assert.equal(request.url, 'http://localhost:5678/healthz');
  assert.deepEqual(request.options, { timeout: 1000 });
});

test('reports n8n health as unavailable on connection failure', async () => {
  const ready = await checkN8nServiceHealth({
    config: { N8N_BASE_URL: 'http://localhost:5678' },
    httpClient: { get: async () => { throw new Error('connection refused'); } },
  });

  assert.equal(ready, false);
});

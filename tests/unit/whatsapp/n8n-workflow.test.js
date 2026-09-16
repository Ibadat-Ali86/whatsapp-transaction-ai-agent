const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWorkflow(filename) {
  const filePath = path.join(__dirname, '../../../n8n/workflows', filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find(candidate => candidate.name === name);
  assert.ok(node, `Missing workflow node: ${name}`);
  return node;
}

function executeCodeNode(node, json, { state = {}, references = {} } = {}) {
  const sandbox = {
    $json: json,
    Date,
    Number,
    Object,
    Intl,
    $getWorkflowStaticData: () => state,
    $: name => ({ first: () => ({ json: references[name] }) }),
  };
  return vm.runInNewContext(`(function () { ${node.parameters.jsCode}\n })()`, sandbox);
}

test('n8n v2 workflow contains a gated Stripe branch without secret values', () => {
  const workflow = loadWorkflow('whatsapp-screenshot-processor_v2_20260910.json');
  const nodeNames = workflow.nodes.map(node => node.name);
  const serialized = JSON.stringify(workflow);

  assert.ok(nodeNames.includes('Stripe Gate Enabled'));
  assert.ok(nodeNames.includes('Stripe Test Verifier'));
  assert.ok(nodeNames.includes('Idempotency Guard'));
  assert.ok(nodeNames.includes('Duplicate Message?'));
  assert.ok(nodeNames.includes('Respond Duplicate'));
  assert.ok(nodeNames.includes('Respond OCR Result'));
  assert.ok(nodeNames.includes('Valid Event?'));
  assert.ok(nodeNames.includes('Respond Invalid Event'));
  const stripeNode = workflow.nodes.find(node => node.name === 'Stripe Test Verifier');
  assert.equal(stripeNode.credentials.httpHeaderAuth.name, 'OCR service Stripe verifier auth');
  assert.equal(stripeNode.credentials.httpHeaderAuth.id, 'CONFIGURE_STRIPE_IN_N8N');
  const webhookNode = workflow.nodes.find(node => node.name === 'WhatsApp Webhook');
  assert.equal(webhookNode.type, 'n8n-nodes-base.webhook');
  assert.equal(webhookNode.typeVersion, 2);
  assert.equal(webhookNode.credentials.httpHeaderAuth.id, 'CONFIGURE_IN_N8N');
  assert.notEqual(stripeNode.credentials.httpHeaderAuth.id, webhookNode.credentials.httpHeaderAuth.id);
  assert.doesNotMatch(stripeNode.parameters.jsonBody, /image\.base64/);
  assert.match(serialized, /stripe_verification_enabled/);
  assert.match(serialized, /STRIPE_LOOKUP_PENDING/);
  assert.match(serialized, /maxBase64Length/);
  assert.match(serialized, /processed_messages/);
  assert.match(serialized, /OCR service Stripe verifier auth/);
  assert.doesNotMatch(serialized, /sk_(live|test)_[A-Za-z0-9]+/);
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
});

test('n8n v1 rollback workflow also bounds image input and disables retention', () => {
  const workflow = loadWorkflow('whatsapp-screenshot-processor_v1_20260909.json');
  const serialized = JSON.stringify(workflow);

  assert.match(serialized, /maxBase64Length/);
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
});

test('Docker production workflow targets the private OCR service name', () => {
  const workflow = loadWorkflow('whatsapp-screenshot-processor_v2_docker_20260915.json');
  const serialized = JSON.stringify(workflow);
  assert.match(serialized, /http:\/\/ocr:8000\/api\/v1\/ocr\/process/);
  assert.match(serialized, /http:\/\/ocr:8000\/api\/v1\/verification\/stripe/);
  assert.doesNotMatch(serialized, /http:\/\/localhost:8000/);
  assert.doesNotMatch(serialized, /sk_(live|test)_[A-Za-z0-9]+/);
});

test('n8n v2 code nodes validate optional captions and prepare recoverable Stripe evidence', () => {
  const workflow = loadWorkflow('whatsapp-screenshot-processor_v2_20260910.json');
  const validate = nodeByName(workflow, 'Validate Event');
  const idempotency = nodeByName(workflow, 'Idempotency Guard');
  const prepare = nodeByName(workflow, 'Prepare Stripe Evidence');
  const baseEvent = {
    processing_id: 'contract-001',
    source: 'whatsapp',
    message_id: 'message-001',
    caption_email: ' Customer@Example.com ',
    received_at: '2026-09-16T18:00:00.000Z',
    stripe_timezone: 'America/Chicago',
    stripe_verification_enabled: true,
    image: { mime_type: 'image/png', base64: 'aGVsbG8=' },
  };

  const validated = executeCodeNode(validate, baseEvent)[0].json;
  assert.equal(validated.caption_email, 'customer@example.com');
  assert.equal(validated.image.base64, 'aGVsbG8=');
  const malformedCaption = executeCodeNode(validate, {
    ...baseEvent,
    caption_email: 'not-an-email',
  })[0].json;
  assert.equal(malformedCaption.valid, true);
  assert.equal(malformedCaption.caption_email, null);
  const captionless = executeCodeNode(validate, {
    ...baseEvent,
    caption_email: '',
  })[0].json;
  assert.equal(captionless.valid, true);
  assert.equal(captionless.caption_email, null);
  const invalidImage = executeCodeNode(validate, {
    ...baseEvent,
    image: { mime_type: 'image/png', base64: 'A'.repeat(14_000_000) },
  })[0].json;
  assert.equal(invalidImage.valid, false);
  assert.equal(invalidImage.validation_error.reason_code, 'INVALID_IMAGE_PAYLOAD');
  assert.equal(invalidImage.image, undefined);

  const state = {};
  const first = executeCodeNode(idempotency, validated, { state })[0].json;
  const second = executeCodeNode(idempotency, validated, { state })[0].json;
  assert.equal(first.idempotency.duplicate, false);
  assert.equal(second.idempotency.duplicate, true);
  assert.equal(first.idempotency.key, 'whatsapp:message-001');

  const ocrEmailDiffers = executeCodeNode(prepare, {
    confidence: 1,
    fields: {
      email: 'different@example.com',
      transaction_id: 'FQ2JKTVZ0',
      amount_cents: 2500,
      minutes: '31',
      payment_date: '2026-09-09',
    },
  }, { references: { 'Validate Event': validated } })[0].json;
  assert.equal(ocrEmailDiffers.ready_for_stripe, true);
  assert.equal(ocrEmailDiffers.stripe_request.email, 'customer@example.com');
  assert.deepEqual(Array.from(ocrEmailDiffers.stripe_request.email_candidates), [
    'customer@example.com',
    'different@example.com',
  ]);
  assert.equal(ocrEmailDiffers.stripe_request.transaction_id, 'FQ2JKTVZ0');

  const ready = executeCodeNode(prepare, {
    confidence: 1,
    fields: {
      email: 'customer@example.com',
      amount_cents: 2500,
      minutes: '31',
      payment_date: '2026-09-09',
    },
  }, { references: { 'Validate Event': validated } })[0].json;
  assert.equal(ready.ready_for_stripe, true);
  assert.equal(ready.stripe_request.email, 'customer@example.com');
  assert.deepEqual(Array.from(ready.stripe_request.email_candidates), ['customer@example.com']);
  assert.equal(ready.stripe_request.transaction_id, null);
  assert.equal(ready.stripe_request.amount_cents, 2500);

  const lowConfidence = executeCodeNode(prepare, {
    confidence: 0.42,
    fields: {
      email: 'customer@example.com',
      amount_cents: 2500,
      minutes: '31',
      payment_date: '2026-09-09',
    },
  }, { references: { 'Validate Event': validated } })[0].json;
  assert.equal(lowConfidence.ready_for_stripe, true);
  assert.equal(lowConfidence.verification.reason_code, 'STRIPE_LOOKUP_PENDING');
  assert.equal(lowConfidence.stripe_request.amount_cents, 2500);
  assert.equal(lowConfidence.stripe_request.payment_date, '2026-09-09');
  assert.equal(lowConfidence.stripe_request.minutes, 31);
  assert.equal(lowConfidence.stripe_request.payment_hour, null);

  const emailOnly = executeCodeNode(prepare, {
    confidence: 0,
    fields: {},
  }, { references: { 'Validate Event': validated } })[0].json;
  assert.equal(emailOnly.ready_for_stripe, true);
  assert.equal(emailOnly.stripe_request.email, 'customer@example.com');
  assert.equal(emailOnly.stripe_request.amount_cents, null);

  const noEmail = executeCodeNode(prepare, {
    confidence: 0.55,
    fields: { amount_cents: 2000, minutes: '23', payment_hour: 9, payment_month: 8, payment_day: 14 },
  }, { references: { 'Validate Event': captionless } })[0].json;
  assert.equal(noEmail.stripe_request.email, null);
  assert.equal(noEmail.stripe_request.amount_cents, 2000);
  assert.equal(noEmail.stripe_request.minutes, 23);
  assert.equal(noEmail.stripe_request.payment_hour, 9);
  assert.equal(noEmail.stripe_request.payment_month, 8);
  assert.equal(noEmail.stripe_request.payment_day, 14);

  const relativeToday = executeCodeNode(prepare, {
    raw_text: 'Today at 6:33 PM',
    confidence: 0.55,
    fields: { amount_cents: 1500, minutes: '33', payment_hour: 18 },
  }, { references: { 'Validate Event': { ...captionless, received_at: '2026-09-16T18:00:00.000Z', stripe_timezone: 'America/Chicago' } } })[0].json;
  assert.equal(relativeToday.stripe_request.payment_date, '2026-09-16');
});

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
  assert.equal(webhookNode.credentials.httpHeaderAuth.id, 'CONFIGURE_IN_N8N');
  assert.notEqual(stripeNode.credentials.httpHeaderAuth.id, webhookNode.credentials.httpHeaderAuth.id);
  assert.doesNotMatch(stripeNode.parameters.jsonBody, /image\.base64/);
  assert.match(serialized, /stripe_verification_enabled/);
  assert.match(serialized, /CAPTION_OCR_EMAIL_CONFLICT/);
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

test('n8n v2 code nodes enforce caption, payload, idempotency, and Stripe gates', () => {
  const workflow = loadWorkflow('whatsapp-screenshot-processor_v2_20260910.json');
  const validate = nodeByName(workflow, 'Validate Event');
  const idempotency = nodeByName(workflow, 'Idempotency Guard');
  const prepare = nodeByName(workflow, 'Prepare Stripe Evidence');
  const baseEvent = {
    processing_id: 'contract-001',
    source: 'whatsapp',
    message_id: 'message-001',
    caption_email: ' Customer@Example.com ',
    stripe_verification_enabled: true,
    image: { mime_type: 'image/png', base64: 'aGVsbG8=' },
  };

  const validated = executeCodeNode(validate, baseEvent)[0].json;
  assert.equal(validated.caption_email, 'customer@example.com');
  assert.equal(validated.image.base64, 'aGVsbG8=');
  const invalidCaption = executeCodeNode(validate, {
    ...baseEvent,
    caption_email: 'not-an-email',
  })[0].json;
  assert.equal(invalidCaption.valid, false);
  assert.equal(invalidCaption.validation_error.reason_code, 'INVALID_CAPTION_EMAIL');
  assert.equal(invalidCaption.image, undefined);
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

  const conflict = executeCodeNode(prepare, {
    fields: {
      email: 'different@example.com',
      amount_cents: 2500,
      minutes: '31',
      payment_date: '2026-09-09',
    },
  }, { references: { 'Validate Event': validated } })[0].json;
  assert.equal(conflict.ready_for_stripe, false);
  assert.equal(conflict.verification.reason_code, 'CAPTION_OCR_EMAIL_CONFLICT');

  const ready = executeCodeNode(prepare, {
    fields: {
      email: 'customer@example.com',
      amount_cents: 2500,
      minutes: '31',
      payment_date: '2026-09-09',
    },
  }, { references: { 'Validate Event': validated } })[0].json;
  assert.equal(ready.ready_for_stripe, true);
  assert.equal(ready.stripe_request.email, 'customer@example.com');
  assert.equal(ready.stripe_request.amount_cents, 2500);
});

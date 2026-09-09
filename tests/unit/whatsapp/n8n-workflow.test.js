const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function loadWorkflow(filename) {
  const filePath = path.join(__dirname, '../../../n8n/workflows', filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('n8n v2 workflow contains a gated Stripe branch without secret values', () => {
  const workflow = loadWorkflow('whatsapp-screenshot-processor_v2_20260910.json');
  const nodeNames = workflow.nodes.map(node => node.name);
  const serialized = JSON.stringify(workflow);

  assert.ok(nodeNames.includes('Stripe Gate Enabled'));
  assert.ok(nodeNames.includes('Stripe Test Verifier'));
  assert.ok(nodeNames.includes('Respond OCR Result'));
  const stripeNode = workflow.nodes.find(node => node.name === 'Stripe Test Verifier');
  assert.equal(stripeNode.credentials.httpHeaderAuth.name, 'OCR service Stripe verifier auth');
  assert.doesNotMatch(stripeNode.parameters.jsonBody, /image\.base64/);
  assert.match(serialized, /stripe_verification_enabled/);
  assert.match(serialized, /CAPTION_OCR_EMAIL_CONFLICT/);
  assert.match(serialized, /OCR service Stripe verifier auth/);
  assert.doesNotMatch(serialized, /sk_(live|test)_[A-Za-z0-9]+/);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
});

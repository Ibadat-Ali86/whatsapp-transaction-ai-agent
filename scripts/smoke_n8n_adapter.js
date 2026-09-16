#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createMessageHandler } = require('../src/whatsapp/message-handler');
const { createDuplicateStore } = require('../src/whatsapp/duplicate-store');

const required = ['N8N_BASE_URL', 'N8N_WEBHOOK_TOKEN'];
const missing = required.filter(name => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(2);
}

const groupId = process.env.SMOKE_GROUP_JID || '1234567890-1234567890@g.us';
const imagePath = path.join(__dirname, '..', 'tests', 'fixtures', 'ocr', 'synthetic_clear_01.png');
const image = fs.readFileSync(imagePath);
let response = null;

const logger = {
  debug() {},
  info() {},
  warn() {},
  error(...args) {
    console.error(...args);
  },
};

const message = {
  key: {
    remoteJid: groupId,
    participant: '923000000000@s.whatsapp.net',
    fromMe: false,
    id: `n8n-adapter-smoke-${Date.now()}`,
  },
  message: {
    imageMessage: {
      mimetype: 'image/png',
      caption: 'testuser@example.com',
    },
  },
};

const sock = {
  async sendMessage(_jid, content) {
    response = content;
  },
};

const handler = createMessageHandler(sock, {
  ALLOWED_GROUP_JIDS: [groupId],
  BOT_REPLY_ENABLED: true,
  BOT_REACTIONS_ENABLED: true,
  REQUIRE_EMAIL_CAPTION: true,
  N8N_ENABLED: true,
  STRIPE_VERIFICATION_ENABLED: false,
}, logger, {
  downloadImage: async () => ({
    imageBytes: image,
    mimeType: 'image/png',
    tempPath: null,
  }),
  duplicateStore: createDuplicateStore({
    filePath: path.join(os.tmpdir(), `wa-n8n-smoke-${process.pid}-${Date.now()}.json`),
  }),
});

handler({ messages: [message] })
  .then(() => {
    // This smoke test intentionally disables Stripe in the handler config so
    // it validates transport/OCR wiring only. A skipped Stripe gate is an
    // unconfirmed result and therefore uses the production warning reaction.
    assert.deepEqual(response?.react?.text, '⚠️');
    assert.equal(response?.react?.key?.id, message.key.id);
    console.log(JSON.stringify({
      ok: true,
      route: 'message-handler -> n8n -> OCR -> Stripe gate -> reaction',
      reaction: response.react.text,
    }));
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });

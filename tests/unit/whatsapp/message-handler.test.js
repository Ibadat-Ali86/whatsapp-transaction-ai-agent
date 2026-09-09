const test = require('node:test');
const assert = require('node:assert/strict');
process.env.WHATSAPP_ALLOWED_GROUP_JIDS ||= '1234567890-1234567890@g.us';
const { createMessageHandler } = require('../../../src/whatsapp/message-handler');

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function imageMessage(remoteJid) {
  return {
    key: {
      remoteJid,
      fromMe: false,
      id: 'test-message-id',
    },
    message: {
      imageMessage: {
        mimetype: 'image/png',
      },
    },
  };
}

function captionedImageMessage(remoteJid, id = 'test-message-id') {
  const message = imageMessage(remoteJid);
  message.key.id = id;
  message.key.participant = '923000000000@s.whatsapp.net';
  message.message.imageMessage.caption = 'Customer@Example.com';
  return message;
}

test('does not process an image from an unallowlisted group', async () => {
  let sendMessageCalled = false;
  const sock = {
    sendMessage: async () => {
      sendMessageCalled = true;
    },
  };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
  }, logger);

  await handler({ messages: [imageMessage('1234567890-9876543210@g.us')] });

  assert.equal(sendMessageCalled, false);
});

test('does not process an image from a direct chat', async () => {
  let sendMessageCalled = false;
  const sock = {
    sendMessage: async () => {
      sendMessageCalled = true;
    },
  };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
  }, logger);

  await handler({ messages: [imageMessage('923220692321@s.whatsapp.net')] });

  assert.equal(sendMessageCalled, false);
});

test('requires a valid email caption before processing an allowlisted image', async () => {
  let sendMessageCalled = false;
  const sock = { sendMessage: async () => { sendMessageCalled = true; } };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: true,
  }, logger);

  await handler({ messages: [imageMessage('1234567890-1234567890@g.us')] });

  assert.equal(sendMessageCalled, true);
});

test('sends a captioned image through OCR once per message ID', async () => {
  let ocrCalls = 0;
  let reply;
  const sock = {
    sendMessage: async (_jid, content) => { reply = content.text; },
  };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: true,
    N8N_ENABLED: false,
  }, logger, {
    downloadImage: async () => ({ imageBytes: Buffer.from('synthetic-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async params => {
      ocrCalls += 1;
      assert.equal(params.captionEmail, 'customer@example.com');
      return { fields: { email: 'customer@example.com', amount_cents: 1000 }, confidence: 0.7, provider: 'tesseract' };
    },
  });

  const message = captionedImageMessage('1234567890-1234567890@g.us', 'unique-message-id');
  await handler({ messages: [message, message] });

  assert.equal(ocrCalls, 1);
  assert.match(reply, /customer@example.com/);
});

test('routes a captioned image through n8n when enabled', async () => {
  let workflowPayload;
  const sock = { sendMessage: async () => {} };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: true,
    N8N_ENABLED: true,
    STRIPE_VERIFICATION_ENABLED: true,
  }, logger, {
    downloadImage: async () => ({ imageBytes: Buffer.from('synthetic-image'), mimeType: 'image/png', tempPath: null }),
    processImageViaN8n: async payload => {
      workflowPayload = payload;
      return { fields: { email: payload.caption_email }, confidence: 1, provider: 'tesseract' };
    },
  });

  await handler({ messages: [captionedImageMessage('1234567890-1234567890@g.us', 'n8n-message-id')] });

  assert.equal(workflowPayload.source, 'whatsapp');
  assert.equal(workflowPayload.caption_email, 'customer@example.com');
  assert.equal(workflowPayload.stripe_verification_enabled, true);
  assert.equal(workflowPayload.image.mime_type, 'image/png');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
process.env.WHATSAPP_ALLOWED_GROUP_JIDS ||= '1234567890-1234567890@g.us';
const { createMessageHandler } = require('../../../src/whatsapp/message-handler');
const { createDuplicateStore } = require('../../../src/whatsapp/duplicate-store');

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function duplicateStore() {
  return createDuplicateStore({ filePath: path.join(os.tmpdir(), `wa-duplicate-test-${process.pid}-${Math.random()}.json`) });
}

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

function standaloneEmailMessage(remoteJid, email, id = 'email-message-id') {
  return {
    key: {
      remoteJid,
      fromMe: false,
      id,
      participant: '923000000000@s.whatsapp.net',
    },
    message: { conversation: email },
  };
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

test('processes a captionless image so Stripe can recover identity from OCR evidence', async () => {
  const events = [];
  const sock = { sendMessage: async (_jid, content) => events.push(content) };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: false,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async () => ({ imageBytes: Buffer.from('captionless-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async params => {
      assert.equal(params.captionEmail, null);
      return {
        fields: { amount_cents: 2000, minutes: '23', payment_hour: 14 },
        confidence: 0.55,
        provider: 'tesseract',
        verification: {
          verdict: 'VALID',
          stripe_charge_id: 'ch-captionless',
          matched_transaction: {
            customer_email: 'recovered@example.com',
            amount_cents: 2000,
            status: 'Completed',
          },
        },
      };
    },
  });

  await handler({ messages: [imageMessage('1234567890-1234567890@g.us')] });

  assert.equal(events.length, 2);
  assert.match(events[0].text, /Email: recovered@example\.com/);
  assert.match(events[0].text, /Stripe Verification: VALID/);
  assert.deepEqual(events[1], { react: { text: '✅', key: imageMessage('1234567890-1234567890@g.us').key } });
});

test('associates a same-sender email message that follows a captionless image', async () => {
  let lookupEmail;
  const groupId = '1234567890-1234567890@g.us';
  const image = imageMessage(groupId);
  image.key.id = 'image-followed-by-email';
  image.key.participant = '923000000000@s.whatsapp.net';
  const handler = createMessageHandler({ sendMessage: async () => {} }, {
    ALLOWED_GROUP_JIDS: [groupId],
    BOT_REPLY_ENABLED: false,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: false,
    CAPTION_ASSOCIATION_WINDOW_MS: 1000,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async () => ({ imageBytes: Buffer.from('follow-up-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async params => {
      lookupEmail = params.captionEmail;
      return { fields: { amount_cents: 1000 }, verification: { verdict: 'VALID', stripe_charge_id: 'ch-follow-up' } };
    },
  });

  const imageProcessing = handler({ messages: [image] });
  await handler({ messages: [standaloneEmailMessage(groupId, 'vinny@example.com')] });
  await imageProcessing;

  assert.equal(lookupEmail, 'vinny@example.com');
});

test('associates a same-sender email message that precedes a captionless image', async () => {
  let lookupEmail;
  const groupId = '1234567890-1234567890@g.us';
  const image = imageMessage(groupId);
  image.key.id = 'image-preceded-by-email';
  image.key.participant = '923000000000@s.whatsapp.net';
  const handler = createMessageHandler({ sendMessage: async () => {} }, {
    ALLOWED_GROUP_JIDS: [groupId],
    BOT_REPLY_ENABLED: false,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: false,
    CAPTION_ASSOCIATION_WINDOW_MS: 1000,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async () => ({ imageBytes: Buffer.from('preceding-email-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async params => {
      lookupEmail = params.captionEmail;
      return { fields: { amount_cents: 1000 }, verification: { verdict: 'VALID', stripe_charge_id: 'ch-preceding-email' } };
    },
  });

  await handler({ messages: [standaloneEmailMessage(groupId, 'before@example.com', 'email-before-image')] });
  await handler({ messages: [image] });

  assert.equal(lookupEmail, 'before@example.com');
});

test('extracts an email from a mixed image caption before Stripe lookup', async () => {
  let lookupEmail;
  const groupId = '1234567890-1234567890@g.us';
  const image = captionedImageMessage(groupId, 'mixed-caption-image');
  image.message.imageMessage.caption = '$2.91 christalrich7@gmail.com';
  const handler = createMessageHandler({ sendMessage: async () => {} }, {
    ALLOWED_GROUP_JIDS: [groupId],
    BOT_REPLY_ENABLED: false,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: false,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async () => ({ imageBytes: Buffer.from('mixed-caption-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async params => {
      lookupEmail = params.captionEmail;
      return { fields: { amount_cents: 291 }, verification: { verdict: 'VALID', stripe_charge_id: 'ch-mixed-caption' } };
    },
  });

  await handler({ messages: [image] });

  assert.equal(lookupEmail, 'christalrich7@gmail.com');
});

test('sends a captioned image through OCR once per message ID', async () => {
  let ocrCalls = 0;
  let reply;
  const sock = {
    sendMessage: async (_jid, content) => { reply = content; },
  };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
    BOT_REACTIONS_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: true,
    N8N_ENABLED: false,
  }, logger, {
    downloadImage: async () => ({ imageBytes: Buffer.from('synthetic-image'), mimeType: 'image/png', tempPath: null }),
    duplicateStore: duplicateStore(),
    processImageOCR: async params => {
      ocrCalls += 1;
      assert.equal(params.captionEmail, 'customer@example.com');
      return {
        fields: { email: 'customer@example.com', amount_cents: 1000 },
        confidence: 0.7,
        provider: 'tesseract',
        verification: { verdict: 'VALID', stripe_charge_id: 'ch-original-test' },
      };
    },
  });

  const message = captionedImageMessage('1234567890-1234567890@g.us', 'unique-message-id');
  await handler({ messages: [message, message] });

  assert.equal(ocrCalls, 1);
  assert.deepEqual(reply.react, { text: '✅', key: message.key });
});

test('uses a warning reaction for an unresolved payment instead of labeling it fake', async () => {
  let reply;
  const sock = {
    sendMessage: async (_jid, content) => { reply = content; },
  };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: false,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: false,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async () => ({ imageBytes: Buffer.from('unclear-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async () => ({
      fields: { amount_cents: 2000 },
      confidence: 0.35,
      provider: 'tesseract',
      verification: { verdict: 'UNCLEAR', reason_code: 'MULTIPLE_EXACT_MATCHES' },
    }),
  });

  const message = imageMessage('1234567890-1234567890@g.us');
  await handler({ messages: [message] });

  assert.deepEqual(reply, { react: { text: '⚠️', key: message.key } });
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
    STRIPE_TIMEZONE: 'America/Chicago',
  }, logger, {
    downloadImage: async () => ({ imageBytes: Buffer.from('synthetic-image'), mimeType: 'image/png', tempPath: null }),
    duplicateStore: duplicateStore(),
    processImageViaN8n: async payload => {
      workflowPayload = payload;
      return { fields: { email: payload.caption_email }, confidence: 1, provider: 'tesseract' };
    },
  });

  await handler({ messages: [captionedImageMessage('1234567890-1234567890@g.us', 'n8n-message-id')] });

  assert.equal(workflowPayload.source, 'whatsapp');
  assert.equal(workflowPayload.caption_email, 'customer@example.com');
  assert.equal(workflowPayload.stripe_verification_enabled, true);
  assert.equal(workflowPayload.stripe_timezone, 'America/Chicago');
  assert.equal(workflowPayload.image.mime_type, 'image/png');
});

test('marks an exact screenshot resend as a duplicate across groups', async () => {
  const replies = [];
  const sock = { sendMessage: async (_jid, content) => replies.push(content) };
  const store = duplicateStore();
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: [
      '1234567890-1234567890@g.us',
      '1234567890-9876543210@g.us',
    ],
    BOT_REPLY_ENABLED: true,
    BOT_REACTIONS_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: true,
    N8N_ENABLED: false,
  }, logger, {
    duplicateStore: store,
    downloadImage: async () => ({ imageBytes: Buffer.from('same-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async params => ({
      fields: { email: params.captionEmail, amount_cents: 2000 },
      confidence: 1,
      provider: 'tesseract',
      verification: { verdict: 'VALID', stripe_charge_id: 'ch-image-test' },
    }),
    getGroupName: async groupId => groupId === '1234567890-1234567890@g.us' ? 'Primary Review Group' : 'Secondary Review Group',
  });

  await handler({ messages: [captionedImageMessage('1234567890-1234567890@g.us', 'first-message')] });
  await handler({ messages: [captionedImageMessage('1234567890-9876543210@g.us', 'second-message')] });

  assert.deepEqual(replies[0].react, { text: '✅', key: captionedImageMessage('1234567890-1234567890@g.us', 'first-message').key });
  assert.match(replies[1].text, /Duplicate Screenshot/);
  assert.match(replies[1].text, /DUPLICATE_IMAGE_SHA256/);
  assert.match(replies[1].text, /the group "Primary Review Group"/);
  assert.match(replies[1].text, /Original Processing ID: wa-/);
});

test('marks a repeated Stripe charge as a transaction duplicate', async () => {
  const replies = [];
  const sock = { sendMessage: async (_jid, content) => replies.push(content) };
  const store = duplicateStore();
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: [
      '1234567890-1234567890@g.us',
      '1234567890-9876543210@g.us',
    ],
    BOT_REPLY_ENABLED: true,
    BOT_REACTIONS_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: true,
    N8N_ENABLED: true,
    STRIPE_VERIFICATION_ENABLED: true,
  }, logger, {
    duplicateStore: store,
    downloadImage: async () => ({ imageBytes: Buffer.from(`image-${replies.length}`), mimeType: 'image/png', tempPath: null }),
    processImageViaN8n: async payload => ({
      fields: { email: payload.caption_email, amount_cents: 2000 },
      confidence: 1,
      provider: 'tesseract',
      verification: {
        status: 'MATCHED',
        verdict: 'VALID',
        reason_code: 'EXACT_SINGLE_MATCH',
        stripe_charge_id: 'ch_same_transaction',
      },
    }),
    getGroupName: async groupId => groupId === '1234567890-1234567890@g.us' ? 'Primary Review Group' : 'Secondary Review Group',
  });

  await handler({ messages: [captionedImageMessage('1234567890-1234567890@g.us', 'transaction-one')] });
  await handler({ messages: [captionedImageMessage('1234567890-9876543210@g.us', 'transaction-two')] });

  assert.deepEqual(replies[0].react, { text: '✅', key: captionedImageMessage('1234567890-1234567890@g.us', 'transaction-one').key });
  assert.match(replies[1].text, /Duplicate Screenshot/);
  assert.match(replies[1].text, /DUPLICATE_STRIPE_TRANSACTION/);
  assert.match(replies[1].text, /Primary Review Group/);
});

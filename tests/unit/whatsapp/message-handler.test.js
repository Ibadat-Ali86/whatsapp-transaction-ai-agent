const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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

test('intakes a 50-group image burst without serial association delays', async () => {
  const groupIds = Array.from({ length: 50 }, (_, index) => `2000000000-${String(index).padStart(10, '0')}@g.us`);
  const reactions = [];
  let processed = 0;
  const storePath = path.join(os.tmpdir(), `wa-50-group-handler-${process.pid}-${Math.random()}.json`);
  const handler = createMessageHandler({
    sendMessage: async (_jid, content) => reactions.push(content),
  }, {
    ALLOWED_GROUP_JIDS: groupIds,
    BOT_REPLY_ENABLED: false,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: false,
    CAPTION_ASSOCIATION_WINDOW_MS: 20,
    PROCESSING_QUEUE_CONCURRENCY: 1,
    PROCESSING_QUEUE_MAX_PENDING: 200,
    PROCESSING_QUEUE_COOLDOWN_MS: 0,
  }, logger, {
    duplicateStore: createDuplicateStore({ filePath: storePath }),
    downloadImage: async (_sock, message) => ({
      imageBytes: Buffer.from(`unique-burst-image-${message.key.remoteJid}`),
      mimeType: 'image/png',
      tempPath: null,
    }),
    processImageOCR: async () => ({
      fields: { amount_cents: 1000 },
      verification: { verdict: 'VALID', stripe_charge_id: `ch-burst-${processed += 1}` },
    }),
  });

  const messages = groupIds.map((groupId, index) => ({
    key: {
      remoteJid: groupId,
      participant: `923000000${String(index).padStart(3, '0')}@s.whatsapp.net`,
      fromMe: false,
      id: `burst-image-${index}`,
    },
    message: { imageMessage: { mimetype: 'image/png' } },
  }));
  const startedAt = Date.now();
  await handler({ messages });
  const elapsedMs = Date.now() - startedAt;

  fs.rmSync(storePath, { force: true });
  assert.equal(processed, 50);
  assert.equal(reactions.length, 50);
  assert.equal(reactions.filter(event => event.react?.text === '✅').length, 50);
  assert.ok(elapsedMs < 1000, `50-group intake took ${elapsedMs}ms`);
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
  assert.match(events[0].text, /Caption email: Not provided/);
  assert.match(events[0].text, /Verified Stripe email \(masked\): r\*\*\*d@example\.com/);
  assert.doesNotMatch(events[0].text, /recovered@example\.com/);
  assert.match(events[0].text, /Justification: No email was supplied in the caption/);
  assert.match(events[0].text, /Stripe Verification: VALID/);
  assert.deepEqual(events[1], { react: { text: '✅', key: imageMessage('1234567890-1234567890@g.us').key } });
});

test('processes a forwarded view-once image wrapped by WhatsApp', async () => {
  const events = [];
  const groupId = '1234567890-1234567890@g.us';
  const message = {
    key: {
      remoteJid: groupId,
      participant: '923000000000@s.whatsapp.net',
      fromMe: false,
      id: 'wrapped-view-once-image',
    },
    message: {
      viewOnceMessageV2: {
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            caption: 'Trees7204@gmail.com',
            contextInfo: { isForwarded: true },
          },
        },
      },
    },
  };
  const handler = createMessageHandler({
    sendMessage: async (_jid, content) => events.push(content),
  }, {
    ALLOWED_GROUP_JIDS: [groupId],
    BOT_REPLY_ENABLED: false,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: false,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async () => ({ imageBytes: Buffer.from('wrapped-view-once'), mimeType: 'image/jpeg', tempPath: null }),
    processImageOCR: async params => {
      assert.equal(params.captionEmail, 'trees7204@gmail.com');
      return { fields: { amount_cents: 700 }, verification: { verdict: 'VALID', stripe_charge_id: 'ch-wrapped-view-once' } };
    },
  });

  await handler({ messages: [message] });

  assert.deepEqual(events, [{ react: { text: '✅', key: message.key } }]);
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

test('shows the canonical Stripe identity when a caption email was mistyped', async () => {
  const replies = [];
  const sock = { sendMessage: async (_jid, content) => replies.push(content) };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: true,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async () => ({ imageBytes: Buffer.from('mistyped-caption-image'), mimeType: 'image/png', tempPath: null }),
    processImageViaN8n: async () => ({
      fields: { email: 'actual@example.com', amount_cents: 2500 },
      confidence: 1,
      provider: 'tesseract',
      verification: {
        status: 'MATCHED',
        verdict: 'VALID',
        reason_code: 'IDENTITY_RECOVERED_FROM_STRIPE',
        stripe_charge_id: 'ch-recovered-identity',
        matched_transaction: {
          customer_email: 'actual@example.com',
          amount_cents: 2500,
          status: 'Completed',
        },
      },
    }),
  });

  const message = captionedImageMessage('1234567890-1234567890@g.us', 'mistyped-caption');
  message.message.imageMessage.caption = 'mistyped@example.com';
  await handler({ messages: [message] });

  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /Email: actual@example\.com/);
  assert.match(replies[0].text, /Stripe Verification: VALID/);
  assert.deepEqual(replies[1], { react: { text: '✅', key: message.key } });
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

test('uses a review reaction and justification for an unresolved payment', async () => {
  const replies = [];
  const sock = {
    sendMessage: async (_jid, content) => { replies.push(content); },
  };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
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

  assert.match(replies[0].text, /Payment Requires Review/);
  assert.match(replies[0].text, /MULTIPLE_EXACT_MATCHES/);
  assert.deepEqual(replies[1], { react: { text: '⚠️', key: message.key } });
});

test('sends complete multi-match proof only to configured private admins', async () => {
  const sent = [];
  const adminJid = '923001234567@s.whatsapp.net';
  const sock = {
    sendMessage: async (jid, content) => { sent.push({ jid, content }); },
  };
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
    BOT_REACTIONS_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: false,
    PAYMENT_REVIEW_ADMIN_JIDS: [adminJid],
    N8N_ENABLED: false,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async () => ({ imageBytes: Buffer.from('private-review-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async () => ({
      fields: { amount_cents: 500, payment_date: '2026-09-21' },
      verification: {
        verdict: 'UNCLEAR',
        reason_code: 'MULTIPLE_EXACT_MATCHES',
        candidate_count: 2,
        candidate_transactions: [
          {
            stripe_charge_id: 'ch_recent_full',
            stripe_customer_id: 'cus_recent_full',
            amount_cents: 500,
            currency: 'usd',
            payment_date: '2026-09-21',
            payment_time: '04:53',
            customer_email: 'alexis@example.com',
            status: 'Completed',
            payment_method_type: 'cashapp',
          },
          {
            stripe_charge_id: 'ch_older_full',
            amount_cents: 500,
            currency: 'usd',
            payment_date: '2026-09-19',
            payment_time: '19:42',
            customer_email: 'alexis@example.com',
            status: 'Completed',
            payment_method_type: 'cashapp',
          },
        ],
      },
    }),
  });

  const message = imageMessage('1234567890-1234567890@g.us');
  await handler({ messages: [message] });

  const privateProof = sent.find(event => event.jid === adminJid);
  const groupReply = sent.find(event => event.jid === message.key.remoteJid && event.content?.text);
  assert.ok(privateProof);
  assert.match(privateProof.content.text, /alexis@example\.com/);
  assert.match(privateProof.content.text, /ch_recent_full/);
  assert.match(privateProof.content.text, /ch_older_full/);
  assert.match(privateProof.content.text, /Do not forward it to public groups/);
  assert.ok(groupReply);
  assert.doesNotMatch(groupReply.content.text, /alexis@example\.com/);
  assert.doesNotMatch(groupReply.content.text, /ch_recent_full/);
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
  const sent = [];
  const sock = {
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, content, options });
      replies.push(content);
    },
  };
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
  assert.match(replies[1].text, /DUPLICATE_IMAGE_SHA256_CONFIRMED/);
  assert.match(replies[1].text, /the group "Primary Review Group"/);
  assert.match(replies[1].text, /Original Processing ID: wa-/);
  assert.match(replies[1].text, /Proof: both submissions resolved to Stripe charge ch-image-test/);
  assert.match(replies[2].text, /Original Screenshot Reference/);
  assert.ok(sent.some(entry => (
    entry.jid === '1234567890-1234567890@g.us'
    && /Original Screenshot Reference/.test(entry.content?.text || '')
    && entry.options?.quoted?.message?.imageMessage
  )));
});

test('does not re-approve an identical image after its first Stripe payment is valid', async () => {
  const sent = [];
  const sock = { sendMessage: async (jid, content) => sent.push({ jid, content }) };
  const store = duplicateStore();
  let verificationCalls = 0;
  const handler = createMessageHandler(sock, {
    ALLOWED_GROUP_JIDS: ['1234567890-1234567890@g.us'],
    BOT_REPLY_ENABLED: true,
    BOT_REACTIONS_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: true,
    N8N_ENABLED: true,
    STRIPE_VERIFICATION_ENABLED: true,
  }, logger, {
    duplicateStore: store,
    downloadImage: async () => ({ imageBytes: Buffer.from('same-image-different-payment'), mimeType: 'image/png', tempPath: null }),
    processImageViaN8n: async payload => ({
      fields: { email: payload.caption_email, amount_cents: 2000 },
      confidence: 1,
      provider: 'tesseract',
      verification: {
        status: 'MATCHED',
        verdict: 'VALID',
        reason_code: 'EXACT_SINGLE_MATCH',
        stripe_charge_id: `ch-new-payment-${++verificationCalls}`,
      },
    }),
  });

  await handler({ messages: [captionedImageMessage('1234567890-1234567890@g.us', 'same-image-first')] });
  await handler({ messages: [captionedImageMessage('1234567890-1234567890@g.us', 'same-image-second')] });

  assert.equal(verificationCalls, 1, 'the already-approved exact image must not be sent to Stripe again');
  assert.ok(sent.some(event => /DUPLICATE_IMAGE_SHA256_CONFIRMED/.test(event.content?.text || '')));
  assert.ok(sent.some(event => /Original Screenshot Reference/.test(event.content?.text || '')));
  assert.equal(sent.filter(event => event.content?.react?.text === '✅').length, 2);
});

test('marks an exact repeat as duplicate even when the first Stripe lookup was unresolved', async () => {
  const sent = [];
  let ocrCalls = 0;
  const store = duplicateStore();
  const groupId = '1234567890-1234567890@g.us';
  const handler = createMessageHandler({
    sendMessage: async (jid, content, options) => sent.push({ jid, content, options }),
  }, {
    ALLOWED_GROUP_JIDS: [groupId],
    BOT_REPLY_ENABLED: true,
    BOT_REACTIONS_ENABLED: true,
    N8N_ENABLED: false,
  }, logger, {
    duplicateStore: store,
    downloadImage: async () => ({ imageBytes: Buffer.from('same-unresolved-image'), mimeType: 'image/png', tempPath: null }),
    processImageOCR: async () => {
      ocrCalls += 1;
      return {
        fields: { amount_cents: 500, transaction_id: 'TJ2WHT1Z0' },
        verification: { verdict: 'UNCLEAR', reason_code: 'NO_EXACT_MATCH', candidate_count: 0 },
      };
    },
  });

  await handler({ messages: [captionedImageMessage(groupId, 'unresolved-first')] });
  await handler({ messages: [captionedImageMessage(groupId, 'unresolved-second')] });

  assert.equal(ocrCalls, 1, 'an exact repeat must not trigger a second lookup after an unresolved attempt');
  assert.ok(sent.some(event => /DUPLICATE_IMAGE_SHA256_UNVERIFIED/.test(event.content?.text || '')));
  assert.ok(sent.some(event => /same SHA-256 fingerprint/.test(event.content?.text || '')));
  assert.ok(sent.some(event => /Original Screenshot Reference/.test(event.content?.text || '')));
});

test('keeps an approved screenshot protected after 59 later screenshots', async () => {
  const sent = [];
  let verificationCalls = 0;
  const groupId = '1234567890-1234567890@g.us';
  const handler = createMessageHandler({
    sendMessage: async (_jid, content) => sent.push(content),
  }, {
    ALLOWED_GROUP_JIDS: [groupId],
    BOT_REPLY_ENABLED: false,
    BOT_REACTIONS_ENABLED: true,
    REQUIRE_EMAIL_CAPTION: true,
    N8N_ENABLED: false,
  }, logger, {
    duplicateStore: duplicateStore(),
    downloadImage: async (_sock, message) => ({
      imageBytes: Buffer.from(message.key.id === 'first-message' || message.key.id === 'first-image-resend'
        ? 'first-approved-image'
        : `later-image-${message.key.id}`),
      mimeType: 'image/png',
      tempPath: null,
    }),
    processImageOCR: async params => ({
      fields: { email: params.captionEmail, amount_cents: 500 },
      verification: { verdict: 'VALID', stripe_charge_id: `ch-burst-${++verificationCalls}` },
    }),
  });

  for (let index = 0; index < 60; index += 1) {
    const id = index === 0 ? 'first-message' : index === 59 ? 'first-image-resend' : `later-message-${index}`;
    await handler({ messages: [captionedImageMessage(groupId, id)] });
  }

  assert.equal(verificationCalls, 59, 'the 60th exact resend must not be re-verified as a new payment');
  assert.equal(sent.length, 60);
  assert.equal(sent[59].react.text, '✅', 'the original screenshot receives the duplicate annotation reaction');
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
  assert.match(replies[2].text, /Original Screenshot Reference/);
});

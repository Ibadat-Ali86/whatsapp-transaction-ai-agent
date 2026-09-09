const test = require('node:test');
const assert = require('node:assert/strict');
process.env.WHATSAPP_ALLOWED_GROUP_JIDS ||= '1234567890-1234567890@g.us';
const { createMessageHandler } = require('../../../src/whatsapp/message-handler');

const logger = {
  debug() {},
  info() {},
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

const test = require('node:test');
const assert = require('node:assert/strict');

test('loads the pinned Baileys v7 API from the CommonJS application boundary', async () => {
  const baileys = await import('@whiskeysockets/baileys');
  const { createConnection } = require('../../../src/whatsapp/connection');

  assert.equal(require('@whiskeysockets/baileys/package.json').version, '7.0.0-rc14');
  assert.equal(typeof baileys.makeWASocket, 'function');
  assert.equal(typeof baileys.makeCacheableSignalKeyStore, 'function');
  assert.equal(typeof baileys.useMultiFileAuthState, 'function');
  assert.equal(typeof baileys.DisconnectReason.loggedOut, 'number');
  assert.equal(typeof createConnection, 'function');
});

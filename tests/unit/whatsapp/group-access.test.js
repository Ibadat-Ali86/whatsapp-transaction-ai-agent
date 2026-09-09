const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAllowedGroupJids,
  isAllowedGroupJid,
  shouldIgnoreJid,
} = require('../../../src/whatsapp/group-access');

test('parses, trims, and de-duplicates comma-separated group JIDs', () => {
  assert.deepEqual(
    parseAllowedGroupJids(
      ' 1234567890-1234567890@g.us,1234567890-9876543210@g.us ',
      '1234567890-1234567890@g.us'
    ),
    [
      '1234567890-1234567890@g.us',
      '1234567890-9876543210@g.us',
    ]
  );
});

test('rejects malformed group JIDs', () => {
  assert.throws(
    () => parseAllowedGroupJids('not-a-group'),
    /Invalid WhatsApp group JID/
  );
});

test('allows only exact configured group JIDs', () => {
  const allowedGroups = ['1234567890-1234567890@g.us'];

  assert.equal(isAllowedGroupJid('1234567890-1234567890@g.us', allowedGroups), true);
  assert.equal(isAllowedGroupJid('1234567890-9876543210@g.us', allowedGroups), false);
  assert.equal(isAllowedGroupJid('923220692321@s.whatsapp.net', allowedGroups), false);
});

test('fails closed when no groups are configured', () => {
  assert.deepEqual(parseAllowedGroupJids('', undefined), []);
  assert.equal(isAllowedGroupJid('1234567890-1234567890@g.us', []), false);
});

test('does not filter direct protocol JIDs needed for group encryption', () => {
  const allowedGroups = ['1234567890-1234567890@g.us'];

  assert.equal(shouldIgnoreJid('1234567890-9876543210@g.us', allowedGroups), true);
  assert.equal(shouldIgnoreJid('923220692321@s.whatsapp.net', allowedGroups), false);
  assert.equal(shouldIgnoreJid('267228989665304@lid', allowedGroups), false);
});

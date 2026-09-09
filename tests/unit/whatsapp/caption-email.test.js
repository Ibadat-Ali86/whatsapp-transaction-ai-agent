const test = require('node:test');
const assert = require('node:assert/strict');
const { getImageCaption, normalizeCaptionEmail } = require('../../../src/whatsapp/caption-email');

test('normalizes a valid image caption email', () => {
  assert.equal(normalizeCaptionEmail('  Customer@Example.COM\n'), 'customer@example.com');
});

test('rejects missing, compound, and malformed captions', () => {
  assert.equal(normalizeCaptionEmail(''), null);
  assert.equal(normalizeCaptionEmail('customer@example.com extra'), null);
  assert.equal(normalizeCaptionEmail('not-an-email'), null);
});

test('reads captions from direct and quoted image messages', () => {
  assert.equal(getImageCaption({ message: { imageMessage: { caption: 'one@example.com' } } }), 'one@example.com');
  assert.equal(getImageCaption({
    message: { extendedTextMessage: { contextInfo: { quotedMessage: { imageMessage: { caption: 'two@example.com' } } } } },
  }), 'two@example.com');
});

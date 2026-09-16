const test = require('node:test');
const assert = require('node:assert/strict');
const { getImageCaption, getStandaloneTextEmail, normalizeCaptionEmail } = require('../../../src/whatsapp/caption-email');

test('normalizes a valid image caption email', () => {
  assert.equal(normalizeCaptionEmail('  Customer@Example.COM\n'), 'customer@example.com');
});

test('extracts one email from a caption with additional payment context', () => {
  assert.equal(normalizeCaptionEmail('$2.91 christalrich7@gmail.com'), 'christalrich7@gmail.com');
  assert.equal(normalizeCaptionEmail('christalrich7@gmail.com amount $2.91'), 'christalrich7@gmail.com');
});

test('rejects missing, ambiguous, and malformed captions', () => {
  assert.equal(normalizeCaptionEmail(''), null);
  assert.equal(normalizeCaptionEmail('one@example.com two@example.com'), null);
  assert.equal(normalizeCaptionEmail('not-an-email'), null);
});

test('reads captions from direct and quoted image messages', () => {
  assert.equal(getImageCaption({ message: { imageMessage: { caption: 'one@example.com' } } }), 'one@example.com');
  assert.equal(getImageCaption({
    message: { extendedTextMessage: { contextInfo: { quotedMessage: { imageMessage: { caption: 'two@example.com' } } } } },
  }), 'two@example.com');
});

test('reads only an email-only standalone text message as a follow-up candidate', () => {
  assert.equal(getStandaloneTextEmail({ message: { conversation: ' Customer@Example.com ' } }), 'customer@example.com');
  assert.equal(getStandaloneTextEmail({ message: { extendedTextMessage: { text: 'customer@example.com' } } }), 'customer@example.com');
  assert.equal(getStandaloneTextEmail({ message: { conversation: 'Please use customer@example.com' } }), null);
});

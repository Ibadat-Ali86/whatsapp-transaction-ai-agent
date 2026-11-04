const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const EMAIL_TOKEN_PATTERN = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
const { getImageMessage } = require('./message-media');

function getImageCaption(message) {
  const imageMessage = getImageMessage(message);
  return imageMessage?.caption
    || message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption
    || '';
}

function normalizeCaptionEmail(caption) {
  if (typeof caption !== 'string' || !caption.trim()) return null;
  let normalized = caption.trim().toLowerCase();

  // Heal common user typos: space or comma instead of dot before common TLDs (e.g., gmail com -> gmail.com)
  normalized = normalized.replace(/@([a-zA-Z0-9-]+)[\s,]+(com|net|org|edu|gov|io|co|ai|me)\b/g, '@$1.$2');
  if (EMAIL_PATTERN.test(normalized)) return normalized;

  // Captions may contain useful context such as "$2.91" or a note beside
  // the identity. Extract exactly one email token and ignore the rest. Two
  // different addresses remain ambiguous and are intentionally rejected.
  const matches = normalized.match(EMAIL_TOKEN_PATTERN) || [];
  const uniqueMatches = [...new Set(matches)];
  return uniqueMatches.length === 1 ? uniqueMatches[0] : null;
}

function getStandaloneText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || '';
}

function getStandaloneTextEmail(message) {
  const normalized = getStandaloneText(message).trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

module.exports = {
  getImageCaption,
  getStandaloneText,
  getStandaloneTextEmail,
  normalizeCaptionEmail,
};

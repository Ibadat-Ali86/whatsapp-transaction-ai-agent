const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function getImageCaption(message) {
  return message?.message?.imageMessage?.caption
    || message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption
    || '';
}

function normalizeCaptionEmail(caption) {
  const normalized = typeof caption === 'string' ? caption.trim().toLowerCase() : '';
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

module.exports = { getImageCaption, normalizeCaptionEmail };

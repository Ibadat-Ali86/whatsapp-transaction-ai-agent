const MESSAGE_WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'albumMessage',
];

function unwrapMessageContent(content) {
  let current = content;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return null;
    const wrapperKey = MESSAGE_WRAPPER_KEYS.find(key => current[key]?.message);
    if (!wrapperKey) return current;
    current = current[wrapperKey].message;
  }
  return current && typeof current === 'object' ? current : null;
}

function getImageMessage(message) {
  const content = unwrapMessageContent(message?.message);
  if (content?.imageMessage || content?.documentMessage) {
    return content.imageMessage || content.documentMessage;
  }

  const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedContent = unwrapMessageContent(quoted);
  if (quotedContent?.imageMessage || quotedContent?.documentMessage) {
    return quotedContent.imageMessage || quotedContent.documentMessage;
  }

  return null;
}

function getImageMimeType(message) {
  const media = getImageMessage(message);
  const mimeType = typeof media?.mimetype === 'string' ? media.mimetype : '';
  return mimeType.startsWith('image/') ? mimeType : '';
}

module.exports = {
  getImageMessage,
  getImageMimeType,
  unwrapMessageContent,
};

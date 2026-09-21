const crypto = require('crypto');

const GROUP_JID_PATTERN = /^[0-9][0-9-]*@g\.us$/;
const PRIVATE_REVIEW_JID_PATTERN = /^[0-9]+@(s\.whatsapp\.net|lid)$/;

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function parseAllowedGroupJids(...values) {
  const groupJids = values
    .filter(value => typeof value === 'string')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);

  const uniqueGroupJids = [...new Set(groupJids)];
  const invalidGroupJids = uniqueGroupJids.filter(jid => !GROUP_JID_PATTERN.test(jid));

  if (invalidGroupJids.length > 0) {
    throw new Error(
      `Invalid WhatsApp group JID(s): ${invalidGroupJids.join(', ')}. Expected values like 1234567890-1234567890@g.us.`
    );
  }

  return uniqueGroupJids;
}

function parsePrivateReviewJids(value) {
  const jids = typeof value === 'string'
    ? value.split(',').map(candidate => candidate.trim()).filter(Boolean)
    : [];
  const uniqueJids = [...new Set(jids)];
  const invalidJids = uniqueJids.filter(jid => !PRIVATE_REVIEW_JID_PATTERN.test(jid));

  if (invalidJids.length > 0) {
    throw new Error(
      `Invalid private review JID(s): ${invalidJids.join(', ')}. Use direct WhatsApp JIDs like 923001234567@s.whatsapp.net.`
    );
  }

  return uniqueJids;
}

function isAllowedGroupJid(remoteJid, allowedGroupJids) {
  return isGroupJid(remoteJid) && Array.isArray(allowedGroupJids) && allowedGroupJids.includes(remoteJid);
}

function shouldIgnoreJid(jid, allowedGroupJids) {
  // Do not filter direct protocol messages: Baileys uses them for group
  // sender-key distribution and Signal session establishment.
  return isGroupJid(jid) && !isAllowedGroupJid(jid, allowedGroupJids);
}

function hashGroupJid(groupJid) {
  return crypto.createHash('sha256').update(groupJid || '').digest('hex').substring(0, 12);
}

module.exports = {
  parseAllowedGroupJids,
  parsePrivateReviewJids,
  isGroupJid,
  isAllowedGroupJid,
  shouldIgnoreJid,
  hashGroupJid,
};

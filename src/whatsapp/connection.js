const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const { logger } = require('./logger');
const config = require('./config');
const { shouldIgnoreJid, hashGroupJid } = require('./group-access');

const MESSAGE_STORE_LIMIT = 256;
const MESSAGE_STORE_TTL_MS = 60 * 60 * 1000;
const RETRY_CACHE_TTL_MS = 60 * 60 * 1000;
const GROUP_METADATA_LIMIT = 16;
const GROUP_METADATA_TTL_MS = 5 * 60 * 1000;

let baileysModulePromise;

function loadBaileys() {
  if (!baileysModulePromise) {
    // Baileys v7 is ESM-only. Keep the application CommonJS boundary stable
    // and load the ESM package once from the async connection setup.
    baileysModulePromise = import('@whiskeysockets/baileys');
  }

  return baileysModulePromise;
}

function createTtlCache(ttlMs) {
  const values = new Map();

  const removeExpired = () => {
    const now = Date.now();
    for (const [key, entry] of values) {
      if (entry.expiresAt <= now) {
        values.delete(key);
      }
    }
  };

  return {
    get(key) {
      removeExpired();
      const entry = values.get(key);
      return entry?.expiresAt > Date.now() ? entry.value : undefined;
    },
    set(key, value) {
      removeExpired();
      values.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    del(key) {
      values.delete(key);
    },
  };
}

function messageStoreKey(key) {
  return `${key.remoteJid || ''}|${key.id || ''}|${key.participant || ''}|${key.fromMe ? '1' : '0'}`;
}

function messageStoreBaseKey(key) {
  return `${key.remoteJid || ''}|${key.id || ''}`;
}

function createOutgoingMessageStore() {
  const exact = new Map();
  const byMessageId = new Map();

  const removeExpired = () => {
    const now = Date.now();
    for (const [key, entry] of exact) {
      if (entry.expiresAt <= now) {
        exact.delete(key);
        if (byMessageId.get(entry.baseKey) === entry) {
          byMessageId.delete(entry.baseKey);
        }
      }
    }
  };

  return {
    put(message) {
      if (!message?.key?.fromMe || !message.message || !message.key.id) {
        return;
      }

      removeExpired();
      const entry = {
        message: message.message,
        baseKey: messageStoreBaseKey(message.key),
        expiresAt: Date.now() + MESSAGE_STORE_TTL_MS,
      };
      exact.set(messageStoreKey(message.key), entry);
      byMessageId.set(entry.baseKey, entry);

      while (exact.size > MESSAGE_STORE_LIMIT) {
        const oldestKey = exact.keys().next().value;
        const oldestEntry = exact.get(oldestKey);
        exact.delete(oldestKey);
        if (oldestEntry && byMessageId.get(oldestEntry.baseKey) === oldestEntry) {
          byMessageId.delete(oldestEntry.baseKey);
        }
      }
    },
    get(key) {
      removeExpired();
      return exact.get(messageStoreKey(key))?.message
        || byMessageId.get(messageStoreBaseKey(key))?.message;
    },
  };
}

function createGroupMetadataCache() {
  const values = new Map();

  const removeExpired = () => {
    const now = Date.now();
    for (const [jid, entry] of values) {
      if (entry.expiresAt <= now) {
        values.delete(jid);
      }
    }
  };

  return {
    get(jid) {
      removeExpired();
      return values.get(jid)?.metadata;
    },
    set(jid, metadata) {
      if (!jid || !metadata) {
        return;
      }

      removeExpired();
      values.delete(jid);
      values.set(jid, {
        metadata,
        expiresAt: Date.now() + GROUP_METADATA_TTL_MS,
      });

      while (values.size > GROUP_METADATA_LIMIT) {
        values.delete(values.keys().next().value);
      }
    },
    del(jid) {
      values.delete(jid);
    },
  };
}

/**
 * Creates and manages the Baileys WhatsApp connection
 * @param {object} options
 * @param {(socket: any) => void} options.onSocket - Called for the initial socket and every replacement socket.
 * @returns {Promise<{socket: any, getSocket: () => any, stop: () => void}>}
 */
async function createConnection({ onSocket } = {}) {
  const {
    makeWASocket,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    DisconnectReason,
  } = await loadBaileys();
  const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);
  const signalKeys = makeCacheableSignalKeyStore(
    state.keys,
    logger.child({ module: 'baileys', component: 'signal-key-store' }),
  );
  const msgRetryCounterCache = createTtlCache(RETRY_CACHE_TTL_MS);
  const outgoingMessageStore = createOutgoingMessageStore();
  const groupMetadataCache = createGroupMetadataCache();

  let activeSocket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopped = false;

  const getStatusCode = error => {
    if (error instanceof Boom) {
      return error.output?.statusCode;
    }

    return error?.output?.statusCode ?? error?.statusCode;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) {
      return;
    }

    const delayMs = Math.min((2 ** Math.min(reconnectAttempt, 5)) * 1000 + 3000, 60000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      logger.info({ delay_ms: delayMs }, 'Reconnecting...');
      try {
        connect();
      } catch (error) {
        logger.error({ err: error }, 'Failed to create replacement WhatsApp socket');
        scheduleReconnect();
      }
    }, delayMs);
  };

  const connect = () => {
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: signalKeys,
      },
      printQRInTerminal: false,
      syncFullHistory: false,
      // Keep retry state shared across socket replacements during this process.
      msgRetryCounterCache,
      // Baileys needs the original outgoing message when WhatsApp requests a resend.
      // This is intentionally bounded and in-memory; it is not a WhatsApp history store.
      getMessage: async key => outgoingMessageStore.get(key),
      // Cache only a small, short-lived set of allowlisted group metadata for
      // outbound group encryption and retry handling.
      cachedGroupMetadata: async jid => groupMetadataCache.get(jid),
      // v7 can recreate missing Signal sessions after a linked-device restart.
      enableAutoSessionRecreation: true,
      // Filter only group messages at the transport layer. Direct protocol
      // messages must remain available for sender-key/session establishment.
      // The message handler repeats the exact group check as defense in depth.
      shouldIgnoreJid: jid => shouldIgnoreJid(jid, config.ALLOWED_GROUP_JIDS),
      logger: logger.child({ module: 'baileys' })
    });

    activeSocket = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const message of messages || []) {
        outgoingMessageStore.put(message);
      }
    });

    const refreshAllowedGroupMetadata = async (groupJid) => {
      if (!config.ALLOWED_GROUP_JIDS.includes(groupJid)) {
        return;
      }

      try {
        const metadata = await sock.groupMetadata(groupJid);
        groupMetadataCache.set(groupJid, metadata);
      } catch (error) {
        logger.debug(
          { group_jid_hash: hashGroupJid(groupJid), err: error },
          'Unable to refresh allowlisted group metadata',
        );
      }
    };

    sock.ev.on('groups.update', updates => {
      for (const update of updates || []) {
        void refreshAllowedGroupMetadata(update.id);
      }
    });

    sock.ev.on('group-participants.update', update => {
      void refreshAllowedGroupMetadata(update?.id);
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('QR Code generated. Scan it to authenticate.');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const statusCode = getStatusCode(lastDisconnect?.error);
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        logger.info({ reason: statusCode, shouldReconnect: !isLoggedOut }, 'Connection closed');

        if (!isLoggedOut) {
          scheduleReconnect();
        } else {
          logger.warn('Logged out from WhatsApp. Need to rescan QR code. Auth state is not deleted automatically.');
        }
      } else if (connection === 'open') {
        reconnectAttempt = 0;
        logger.info({ allowed_group_count: config.ALLOWED_GROUP_JIDS.length }, 'WhatsApp connection opened successfully.');
      }
    });

    onSocket?.(sock);

    return sock;
  };

  const initialSocket = connect();

  return {
    socket: initialSocket,
    getSocket: () => activeSocket,
    stop: () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      activeSocket?.ws?.close();
    },
  };
}

module.exports = { createConnection };

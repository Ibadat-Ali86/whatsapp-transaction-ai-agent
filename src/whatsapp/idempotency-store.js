function createIdempotencyStore({ ttlMs = 60 * 60 * 1000, maxEntries = 4096 } = {}) {
  const entries = new Map();

  const removeExpired = () => {
    const now = Date.now();
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(key);
    }
  };

  return {
    has(key) {
      removeExpired();
      return entries.has(key);
    },
    claim(key) {
      removeExpired();
      if (entries.has(key)) return false;
      entries.set(key, Date.now() + ttlMs);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      return true;
    },
    add(key) {
      this.claim(key);
    },
    complete() {},
    release(key) {
      entries.delete(key);
    },
  };
}

module.exports = { createIdempotencyStore };

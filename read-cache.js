// Short-lived, memory-only reads. Clearing also discards in-flight results.
export function createReadCache({ ttl = 15000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key, loader, force = false) {
      const previous = entries.get(key);
      if (previous?.pending) return previous.pending;
      if (!force && previous && previous.expires > now()) return Promise.resolve(previous.value);
      const entry = {};
      entries.set(key, entry);
      entry.pending = Promise.resolve().then(loader).then(value => {
        if (entries.get(key) === entry) {
          entry.value = value;
          entry.expires = now() + ttl;
          delete entry.pending;
        }
        return value;
      }, error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      return entry.pending;
    },
    invalidate(key) { entries.delete(key); },
    clear() { entries.clear(); }
  };
}

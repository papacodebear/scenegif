const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions) if (entry.expiresAt < now) sessions.delete(key);
}, 5 * 60 * 1000).unref();

export function setSession(key, data, ttlSeconds) {
  sessions.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function getSession(key) {
  const entry = sessions.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(key);
    return null;
  }
  return entry.data;
}

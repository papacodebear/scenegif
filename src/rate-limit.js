import { config } from './config.js';

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt < now) buckets.delete(key);
}, 5 * 60 * 1000).unref();

export function checkRateLimit(userId) {
  const now = Date.now();
  const bucket = buckets.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= config.rateLimitPerMin;
}

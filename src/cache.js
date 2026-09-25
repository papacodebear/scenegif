import { createHash } from 'crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from 'fs';
import path from 'path';

import { config } from './config.js';

const store = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) if (entry.expiresAt && entry.expiresAt < now) store.delete(key);
}, 60 * 60 * 1000).unref();

export function sceneHash(...parts) {
  const combined = parts.map(p => p.toLowerCase().trim()).join('|');
  return createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheSet(key, value, ttl = null) {
  store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
}

export function clipPath(videoId, t0, t1, height) {
  mkdirSync(config.clipCacheDir, { recursive: true });
  return path.join(config.clipCacheDir, `${videoId}_${t0.toFixed(2)}_${t1.toFixed(2)}_${height}.mp4`);
}

export function evictClipCache() {
  const dir = config.clipCacheDir;
  let files;
  try {
    files = readdirSync(dir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const p = path.join(dir, f);
        return { path: p, ...statSync(p) };
      })
      .sort((a, b) => a.atimeMs - b.atimeMs);
  } catch {
    return;
  }
  const maxBytes = config.clipCacheMaxGb * 1024 ** 3;
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const file of files) {
    if (total <= maxBytes) break;
    try { unlinkSync(file.path); } catch {}
    total -= file.size;
  }
}

export function touchClip(filePath) {
  const now = new Date();
  try { utimesSync(filePath, now, now); } catch {}
}

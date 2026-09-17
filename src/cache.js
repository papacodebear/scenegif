import { createHash } from 'crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from 'fs';
import path from 'path';
import { URL } from 'url';

import { Redis } from 'ioredis';

import { config } from './config.js';

export function redisClient() {
  return new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
}

export function redisConnection() {
  const u = new URL(config.redisUrl);
  return {
    host: u.hostname,
    port: parseInt(u.port) || 6379,
    password: u.password || undefined,
    db: parseInt(u.pathname.slice(1)) || 0,
  };
}

export function sceneHash(...parts) {
  const combined = parts.map(p => p.toLowerCase().trim()).join('|');
  return createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

export async function cacheGet(redis, key) {
  const raw = await redis.get(key);
  return raw != null ? JSON.parse(raw) : null;
}

export async function cacheSet(redis, key, value, ttl = null) {
  const payload = JSON.stringify(value);
  if (ttl) await redis.setex(key, ttl, payload);
  else await redis.set(key, payload);
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

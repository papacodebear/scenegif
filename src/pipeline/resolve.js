import { spawn } from 'child_process';

import { cacheGet, cacheSet, sceneHash } from '../cache.js';
import { config } from '../config.js';
import { NoResultsError } from '../errors.js';

const MAX_DURATION = 20 * 60;

function ytdlpBase() {
  const args = ['--no-warnings', '--quiet'];
  if (config.ytDlpCookies) args.push('--cookies', config.ytDlpCookies);
  if (config.ytDlpPoToken) args.push('--extractor-args', `youtube:po_token=${config.ytDlpPoToken}`);
  return args;
}

function rank(entry, scene) {
  const duration = entry.duration || 0;
  const views = entry.view_count || 0;
  const titleWords = new Set((entry.title || '').toLowerCase().match(/\w+/g) || []);
  const sceneWords = new Set(scene.toLowerCase().match(/\w+/g) || []);
  const overlap = [...titleWords].filter(w => sceneWords.has(w)).length;

  let score = overlap * 10;
  score += duration < 300 ? 20 : duration < 600 ? 5 : 0;
  score += Math.min(views / 1_000_000, 3);
  return score;
}

function spawnLines(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => errChunks.push(d));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(Buffer.concat(errChunks).toString()));
      else resolve(Buffer.concat(chunks).toString());
    });
  });
}

async function search(scene) {
  const args = [...ytdlpBase(), '--dump-json', '--flat-playlist', '--', `ytsearch5:${scene}`];
  let stdout;
  try {
    stdout = await spawnLines('yt-dlp', args);
  } catch {
    throw new NoResultsError('YouTube search failed. Try again in a moment.');
  }
  return stdout.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export async function resolve(scene) {
  const key = `resolve:${sceneHash(scene)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const results = await search(scene);
  const eligible = results.filter(r => (r.duration || 0) > 0 && (r.duration || 0) <= MAX_DURATION);

  if (!eligible.length) {
    if (results.length) throw new NoResultsError("Found clips, but they're all too long. Try a more specific scene description.");
    throw new NoResultsError("Couldn't find a clip for that scene.");
  }

  const best = eligible.reduce((a, b) => rank(a, scene) >= rank(b, scene) ? a : b);
  cacheSet(key, best.id, 30 * 24 * 3600);
  return best.id;
}

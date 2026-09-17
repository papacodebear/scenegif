import { spawn } from 'child_process';
import { existsSync } from 'fs';

import { clipPath, evictClipCache, touchClip } from '../cache.js';
import { config } from '../config.js';
import { DownloadBlockedError } from '../errors.js';

const MAX_PARALLEL = 3;
let _active = 0;
const _queue = [];

function acquireSemaphore() {
  return new Promise(resolve => {
    if (_active < MAX_PARALLEL) { _active++; resolve(); }
    else _queue.push(resolve);
  });
}

function releaseSemaphore() {
  _active--;
  if (_queue.length) { _active++; _queue.shift()(); }
}

async function download(videoId, t0, t1, height, dest) {
  const args = [
    '-f', `bv*[height<=${height}]`,
    '--download-sections', `*${t0}-${t1}`,
    '--force-keyframes-at-cuts',
    '--no-playlist', '--quiet', '--no-warnings',
    '-o', dest,
  ];
  if (config.ytDlpCookies) args.push('--cookies', config.ytDlpCookies);
  if (config.ytDlpPoToken) args.push('--extractor-args', `youtube:po_token=${config.ytDlpPoToken}`);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  const stderr = await new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks = [];
    proc.stderr.on('data', d => chunks.push(d));
    proc.on('close', code => {
      const err = Buffer.concat(chunks).toString();
      if (code !== 0 || !existsSync(dest)) reject(err);
      else resolve(err);
    });
  });

  void stderr; // stderr captured only for error diagnosis
}

export async function extract(videoId, t0, t1, height = 720) {
  const dest = clipPath(videoId, t0, t1, height);
  if (existsSync(dest)) { touchClip(dest); return dest; }

  evictClipCache();
  await acquireSemaphore();
  try {
    if (existsSync(dest)) { touchClip(dest); return dest; }
    await download(videoId, t0, t1, height, dest).catch(err => {
      if (/429|403|blocked|Sign in/i.test(err)) {
        throw new DownloadBlockedError('YouTube is blocking downloads right now. Try again later.');
      }
      throw new DownloadBlockedError("Couldn't download the clip. Try again in a moment.");
    });
    return dest;
  } finally {
    releaseSemaphore();
  }
}

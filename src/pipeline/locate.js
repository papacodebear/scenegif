import { spawn } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { env, pipeline } from '@huggingface/transformers';

import { cacheGet, cacheSet, redisClient, sceneHash } from '../cache.js';
import { config } from '../config.js';

env.cacheDir = '/app/.cache/transformers';

const WINDOW_SIZE = 4;
const WINDOW_STEP = 2;

let _extractor = null;

export async function getExtractor() {
  if (!_extractor) _extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return _extractor;
}

function vttTime(s) {
  const parts = s.split(':');
  if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
  return +parts[0] * 60 + parseFloat(parts[1]);
}

function parseVtt(text) {
  const cues = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const tsLine = lines.find(l => l.includes(' --> '));
    if (!tsLine) continue;
    const [startRaw, endRaw] = tsLine.split(' --> ');
    try {
      const start = vttTime(startRaw.trim().split(' ')[0]);
      const end = vttTime(endRaw.trim().split(' ')[0]);
      const caption = lines
        .filter(l => !l.includes(' --> ') && !/^\d+$/.test(l.trim()))
        .join(' ')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (caption) cues.push({ start, end, text: caption });
    } catch {}
  }
  return cues;
}

function makeWindows(cues) {
  const windows = [];
  for (let i = 0; i < Math.max(1, cues.length - WINDOW_SIZE + 1); i += WINDOW_STEP) {
    const chunk = cues.slice(i, i + WINDOW_SIZE);
    windows.push({ start: chunk[0].start, end: chunk.at(-1).end, text: chunk.map(c => c.text).join(' ') });
  }
  return windows;
}

function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

async function rankWindows(windows, scene) {
  const extractor = await getExtractor();
  const texts = [...windows.map(w => w.text), scene];
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const embs = output.tolist();
  const sceneEmb = embs.at(-1);
  return windows
    .map((w, i) => ({ ...w, score: dot(embs[i], sceneEmb) }))
    .sort((a, b) => b.score - a.score);
}

async function fetchSubtitles(videoId) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'scenegif-'));
  const args = [
    '--write-auto-sub', '--sub-format', 'vtt', '--sub-langs', 'en',
    '--skip-download', '--quiet', '--no-warnings',
    '-o', path.join(tmp, 'sub'),
  ];
  if (config.ytDlpCookies) args.push('--cookies', config.ytDlpCookies);
  if (config.ytDlpPoToken) args.push('--extractor-args', `youtube:po_token=${config.ytDlpPoToken}`);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  await new Promise(resolve => {
    const proc = spawn('yt-dlp', args, { stdio: 'ignore' });
    proc.on('close', resolve);
  });

  const vttFile = readdirSync(tmp).find(f => f.endsWith('.vtt'));
  if (!vttFile) return null;
  return readFileSync(path.join(tmp, vttFile), 'utf8');
}

async function heatmapFallback(videoId) {
  const args = [
    '--dump-single-json', '--skip-download', '--quiet', '--no-warnings',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  if (config.ytDlpCookies) args.push('--cookies', config.ytDlpCookies);

  const stdout = await new Promise(resolve => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', () => resolve(Buffer.concat(chunks).toString()));
  });

  try {
    const info = JSON.parse(stdout);
    const duration = parseFloat(info.duration) || 60;
    const heatmap = info.heatmap;
    if (heatmap?.length) {
      const peak = heatmap.reduce((a, b) => (a.value >= b.value ? a : b));
      const t0 = parseFloat(peak.start_time);
      return [t0, Math.min(t0 + 5, duration)];
    }
    const t0 = duration * 0.15;
    return [t0, Math.min(t0 + 5, duration)];
  } catch {
    return [0, 5];
  }
}

export async function locate(videoId, scene) {
  const key = `locate:${sceneHash(videoId, scene)}`;
  const redis = redisClient();
  try {
    const cached = await cacheGet(redis, key);
    if (cached) {
      const [t0, t1, rawWindows] = cached;
      return [t0, t1, rawWindows.map(w => [w[0], w[1]])];
    }

    const vtt = await fetchSubtitles(videoId);
    const cues = vtt ? parseVtt(vtt) : [];

    let windows, t0, t1;
    if (cues.length) {
      const ranked = await rankWindows(makeWindows(cues), scene);
      windows = ranked.map(w => [w.start, w.end]);
      [t0, t1] = windows[0];
    } else {
      [t0, t1] = await heatmapFallback(videoId);
      windows = [[t0, t1]];
    }

    await cacheSet(redis, key, [t0, t1, windows]);
    return [t0, t1, windows];
  } finally {
    redis.disconnect();
  }
}

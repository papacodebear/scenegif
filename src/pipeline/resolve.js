import { spawn } from 'child_process';

import { cacheGet, cacheSet, sceneHash } from '../cache.js';
import { config } from '../config.js';
import { NoResultsError } from '../errors.js';
import { termOverlap, terms } from '../text.js';

const MAX_DURATION = 20 * 60;
const SEARCH_COUNT = 8;

function ytdlpBase() {
  const args = ['--no-warnings', '--quiet'];
  if (config.ytDlpCookies) args.push('--cookies', config.ytDlpCookies);
  if (config.ytDlpPoToken) args.push('--extractor-args', `youtube:po_token=${config.ytDlpPoToken}`);
  return args;
}

// YouTube's own order is the strongest relevance signal; title overlap and length refine it.
function rank(entry, position, sceneTerms) {
  const duration = entry.duration || 0;
  const views = entry.view_count || 0;
  const overlap = termOverlap(sceneTerms, terms(entry.title || ''));

  let score = overlap * 10;
  score += Math.max(0, 30 - position * 5);
  score += duration < 300 ? 10 : duration < 600 ? 3 : 0;
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
  const args = [...ytdlpBase(), '--dump-json', '--flat-playlist', '--', `ytsearch${SEARCH_COUNT}:${scene}`];
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

function toVideo(entry) {
  return { id: entry.id, title: entry.title || 'YouTube video', duration: entry.duration || null };
}

// Returns eligible search results as { id, title, duration }, best guess first.
export async function resolve(scene) {
  const key = `resolve:${sceneHash(scene)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const results = await search(scene);
  const sceneTerms = terms(scene);
  const eligible = results
    .map((r, position) => ({ r, score: rank(r, position, sceneTerms) }))
    .filter(({ r }) => (r.duration || 0) > 0 && r.duration <= MAX_DURATION);

  if (!eligible.length) {
    if (results.length) throw new NoResultsError("Found clips, but they're all too long. Try a more specific scene description.");
    throw new NoResultsError("Couldn't find a clip for that scene.");
  }

  const videos = eligible.sort((a, b) => b.score - a.score).map(({ r }) => toVideo(r));
  cacheSet(key, videos, 30 * 24 * 3600);
  return videos;
}

// Looks up title and duration for a specific video, for links pasted into /clip.
export async function videoInfo(videoId) {
  const key = `info:${videoId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let info;
  try {
    const args = [...ytdlpBase(), '--dump-single-json', '--skip-download', '--', `https://www.youtube.com/watch?v=${videoId}`];
    info = JSON.parse(await spawnLines('yt-dlp', args));
  } catch {
    throw new NoResultsError("Couldn't load that video. Check the link and try again.");
  }

  const video = toVideo(info);
  cacheSet(key, video, 24 * 3600);
  return video;
}

import { spawn } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import Piscina from 'piscina';

import { cacheGet, cacheSet, sceneHash } from '../cache.js';
import { config } from '../config.js';
import { termOverlap, terms } from '../text.js';
import { DEFAULT_GIF_SECONDS } from './render.js';

const SUB_LANGS = ['en', 'en-US', 'en-GB'];
const MAX_MATCHES = 10;
const LEAD_IN = 0.5;
const CONTEXT_BEFORE = 1;
const CONTEXT_AFTER = 2;
const LEXICAL_WEIGHT = 0.3;
const HEAT_WEIGHT = 0.15;
const HEAT_PEAKS = 3;

const embedPool = new Piscina({
  filename: new URL('./embed-worker.js', import.meta.url).href,
});

// Force the ONNX model to load before the first real request hits it.
export async function warmupEmbedder() {
  await embedPool.run(['warmup']);
}

function vttTime(s) {
  const parts = s.split(':');
  if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
  return +parts[0] * 60 + parseFloat(parts[1]);
}

const WORD_STAMP = /<(\d{2}:)?\d{2}:\d{2}\.\d{3}>/;

function cleanCaption(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Auto-captions roll: every cue repeats the previous line, so only the last line of each cue is new speech.
function parseVtt(text) {
  const rolling = WORD_STAMP.test(text);
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const tsIdx = lines.findIndex(l => l.includes(' --> '));
    if (tsIdx < 0) continue;

    const [startRaw, endRaw] = lines[tsIdx].split(' --> ');
    const start = vttTime(startRaw.trim());
    let end = vttTime(endRaw.trim().split(/\s/)[0]);
    if (!(end - start > 0.05)) continue;

    let body = lines.slice(tsIdx + 1);
    if (rolling) body = body.filter(l => l.trim()).slice(-1);

    // Rolling cues stay on screen long after the words; end shortly after the last word starts instead.
    const stamps = [...body.join(' ').matchAll(/<((?:\d{2}:)?\d{2}:\d{2}\.\d{3})>/g)].map(m => vttTime(m[1]));
    if (stamps.length) end = Math.min(end, stamps.at(-1) + 1);

    const caption = cleanCaption(body.join(' '));
    if (!caption) continue;
    const prev = cues.at(-1);
    if (prev?.text === caption) { prev.end = Math.max(prev.end, end); continue; }
    cues.push({ start, end, text: caption });
  }
  return cues;
}

function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

function heatAt(heatmap, t) {
  return heatmap.find(h => h.start_time <= t && t < h.end_time)?.value ?? 0;
}

// Most-replayed segments, spaced apart so each peak is a distinct moment.
function heatPeaks(heatmap, count) {
  const peaks = [];
  for (const seg of [...heatmap].sort((a, b) => b.value - a.value)) {
    if (peaks.some(p => Math.abs(p.start_time - seg.start_time) < DEFAULT_GIF_SECONDS * 2)) continue;
    peaks.push(seg);
    if (peaks.length === count) break;
  }
  return peaks;
}

// Words naming the video (film, character) identify the clip, not the moment, so try the query without them too.
function queryVariants(scene, title) {
  const titleTerms = terms(title ?? '');
  const moment = scene.split(/\s+/).filter(w => !termOverlap(terms(w), titleTerms)).join(' ');
  return terms(moment).size && moment !== scene ? [scene, moment] : [scene];
}

// Scores each cue on its own text and with neighbouring cues as context, so the match lands on the line itself.
async function rankCues(cues, queries, heatmap) {
  const contexts = cues.map((_, i) => cues.slice(Math.max(0, i - CONTEXT_BEFORE), i + CONTEXT_AFTER + 1).map(c => c.text).join(' '));
  const embs = await embedPool.run([...contexts, ...cues.map(c => c.text), ...queries]);
  const queryEmbs = embs.slice(-queries.length);
  const queryTerms = queries.map(terms).filter(t => t.size);

  return cues.map((cue, i) => {
    const semantic = Math.max(...queryEmbs.map(q => 0.5 * dot(embs[i], q) + 0.5 * dot(embs[cues.length + i], q)));
    const contextTerms = terms(contexts[i]);
    const cueTerms = terms(cue.text);
    const lexical = Math.max(0, ...queryTerms.map(t => (termOverlap(t, contextTerms) + termOverlap(t, cueTerms)) / (2 * t.size)));
    return {
      start: cue.start,
      text: cue.text,
      score: semantic + LEXICAL_WEIGHT * lexical + HEAT_WEIGHT * heatAt(heatmap, cue.start),
    };
  });
}

function clipRange(anchor, duration) {
  let start = Math.max(0, anchor - LEAD_IN);
  if (duration) start = Math.max(0, Math.min(start, duration - DEFAULT_GIF_SECONDS));
  const end = start + DEFAULT_GIF_SECONDS;
  return { start, end: duration ? Math.min(end, duration) : end };
}

function distinctMatches(candidates, duration) {
  const kept = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    const range = clipRange(c.start, duration);
    if (kept.some(k => range.start < k.end && k.start < range.end)) continue;
    kept.push({ ...range, text: c.text });
    if (kept.length === MAX_MATCHES) break;
  }
  return kept;
}

function pickSubtitleFile(files, info) {
  const candidates = files
    .filter(f => f.endsWith('.vtt'))
    .map(f => ({ file: f, lang: f.slice('v.'.length, -'.vtt'.length) }));
  const order = c => (info.subtitles?.[c.lang] ? 0 : 10) + Math.max(0, SUB_LANGS.indexOf(c.lang));
  return candidates.sort((a, b) => order(a) - order(b))[0]?.file ?? null;
}

// One yt-dlp call for subtitles plus the info JSON, which carries duration and the most-replayed heatmap.
async function fetchTrack(videoId) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'scenegif-'));
  const args = [
    '--write-subs', '--write-auto-subs', '--sub-format', 'vtt', '--sub-langs', SUB_LANGS.join(','),
    '--write-info-json', '--skip-download', '--quiet', '--no-warnings',
    '-o', path.join(tmp, 'v'),
  ];
  if (config.ytDlpCookies) args.push('--cookies', config.ytDlpCookies);
  if (config.ytDlpPoToken) args.push('--extractor-args', `youtube:po_token=${config.ytDlpPoToken}`);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  const stderr = await new Promise(resolve => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks = [];
    proc.stderr.on('data', d => chunks.push(d));
    proc.on('close', () => resolve(Buffer.concat(chunks).toString()));
  });
  if (/ERROR/.test(stderr)) console.warn(`yt-dlp subtitle fetch for ${videoId}:`, stderr.trim().split('\n').at(-1));

  try {
    const files = readdirSync(tmp);
    const infoFile = files.find(f => f.endsWith('.info.json'));
    let info = {};
    try { if (infoFile) info = JSON.parse(readFileSync(path.join(tmp, infoFile), 'utf8')); } catch {}
    const vttFile = pickSubtitleFile(files, info);
    return { info, vtt: vttFile ? readFileSync(path.join(tmp, vttFile), 'utf8') : null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Returns ranked, non-overlapping matches as { start, end, text }; text is null for heatmap-only picks.
export async function locate(videoId, scene) {
  const key = `locate:${sceneHash(videoId, scene)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const { info, vtt } = await fetchTrack(videoId);
  const duration = parseFloat(info.duration) || null;
  const heatmap = info.heatmap ?? [];
  const cues = vtt ? parseVtt(vtt) : [];

  const candidates = heatPeaks(heatmap, cues.length ? HEAT_PEAKS : MAX_MATCHES)
    .map(seg => ({ start: seg.start_time, text: null, score: HEAT_WEIGHT * seg.value }));
  if (cues.length) candidates.push(...await rankCues(cues, queryVariants(scene, info.title), heatmap));
  if (!candidates.length) candidates.push({ start: (duration ?? 60) * 0.15, text: null, score: 0 });

  const windows = distinctMatches(candidates, duration);
  cacheSet(key, windows);
  return windows;
}

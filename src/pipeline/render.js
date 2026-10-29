import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { RenderError } from '../errors.js';

// Just under Discord's 10MiB attachment cap, leaving room for multipart overhead.
const SIZE_LIMIT = 9.5 * 1024 * 1024;
// [fps, width, palette colors], best quality first.
const PROFILES = [
  [12, 480, 256], [10, 480, 256], [10, 400, 256], [8, 400, 192],
  [8, 360, 128], [8, 320, 128], [6, 320, 96], [6, 280, 64], [5, 240, 64],
];
export const DEFAULT_GIF_SECONDS = 4.0;
export const MAX_GIF_SECONDS = 60.0;
const PROBE_SECONDS = 10.0;
const DURATION_STEPS = [0.85, 0.7, 0.55];
// gifsicle --lossy levels, tried in order before dropping to a smaller profile.
const LOSSY_LEVELS = [40, 80];

function assTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(Math.floor((s % 1) * 100)).padStart(2, '0')}`;
}

function buildAss(caption, duration) {
  const safe = caption.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
  const end = assTime(duration + 0.5);
  return (
    '[Script Info]\nScriptType: v4.00+\nPlayResX: 480\nPlayResY: 270\nWrapStyle: 0\n\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
    'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
    'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,' +
    '-1,0,0,0,100,100,0,0,1,3,0,2,10,10,20,1\n\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    `Dialogue: 0,0:00:00.00,${end},Default,,0,0,0,,${safe}\n`
  );
}

async function encode(clipPath, caption, duration, [fps, width, colors]) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'scenegif-'));
  const outPath = path.join(tmp, 'out.gif');

  // Denoise so grain doesn't dither into LZW-defeating noise; mpdecimate drops near-duplicate frames.
  let vf = `fps=${fps},scale=${width}:-1:flags=lanczos,hqdn3d=2:1.5:4:3,mpdecimate`;
  if (caption) {
    const assPath = path.join(tmp, 'cap.ass');
    writeFileSync(assPath, buildAss(caption, duration), 'utf8');
    vf += `,ass=${assPath}`;
  }
  vf += `,split[a][b];[a]palettegen=stats_mode=diff:reserve_transparent=0:max_colors=${colors}[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`;

  // Full opaque frames: transdiff/offset frames can leave Discord mobile stuck on the blurred placeholder.
  const args = ['-y', '-i', clipPath, '-t', String(duration), '-vf', vf, '-fps_mode', 'vfr', '-gifflags', '-offsetting-transdiff', '-loop', '0', outPath];

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errChunks = [];
    proc.stderr.on('data', d => errChunks.push(d));
    proc.on('close', code => {
      if (code !== 0) reject(new RenderError('Failed to render GIF. The clip may be malformed.'));
      else resolve();
    });
  });

  try {
    return readFileSync(outPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Lossy LZW: perturbs pixels slightly so runs compress better, without touching frames or size.
async function lossy(gif, level) {
  return new Promise((resolve, reject) => {
    const proc = spawn('gifsicle', [`--lossy=${level}`], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) reject(new RenderError('Failed to compress GIF.'));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.end(gif);
  });
}

async function fitLossy(gif) {
  if (gif.length <= SIZE_LIMIT) return gif;
  for (const level of LOSSY_LEVELS) {
    const out = await lossy(gif, level);
    if (out.length <= SIZE_LIMIT) return out;
  }
  return null;
}

// GIF size scales roughly with fps × pixel count, so one probe encode predicts the rest.
function estimate(probe, [fps0, w0], [fps, w]) {
  return probe * (fps / fps0) * (w / w0) ** 2;
}

export async function render(clipPath, caption, t0, t1, maxDuration = MAX_GIF_SECONDS) {
  const duration = Math.min(t1 - t0, maxDuration);
  const probeDuration = Math.min(duration, PROBE_SECONDS);
  const probeGif = await encode(clipPath, caption, probeDuration, PROFILES[0]);
  if (probeDuration === duration) {
    const fit = await fitLossy(probeGif);
    if (fit) return fit;
  }

  // Long clips are probed on their first few seconds and extrapolated, rather than fully encoded at top quality.
  const gain = (await lossy(probeGif, LOSSY_LEVELS.at(-1))).length / probeGif.length;
  const probe = probeGif.length * (duration / probeDuration) * gain;
  const start = probeDuration === duration ? 1 : 0;
  let gif;
  for (const profile of PROFILES.slice(start)) {
    if (profile !== PROFILES.at(-1) && estimate(probe, PROFILES[0], profile) > SIZE_LIMIT * 1.2) continue;
    gif = await encode(clipPath, caption, duration, profile);
    const fit = await fitLossy(gif);
    if (fit) return fit;
  }

  for (const frac of DURATION_STEPS) {
    gif = await lossy(await encode(clipPath, caption, duration * frac, PROFILES.at(-1)), LOSSY_LEVELS.at(-1));
    if (gif.length <= SIZE_LIMIT) return gif;
  }

  return gif; // deliver stage will CDN if still over
}

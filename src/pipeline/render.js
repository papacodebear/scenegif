import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { RenderError } from '../errors.js';

const SIZE_LIMIT = 8 * 1024 * 1024;
const PROFILES = [[12, 480], [10, 480], [8, 480], [8, 400], [8, 360], [8, 320]];
const DURATION_STEPS = [4.0, 3.5, 3.0, 2.5];

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

async function encode(clipPath, caption, duration, fps, width) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'scenegif-'));
  const outPath = path.join(tmp, 'out.gif');

  let vf = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  if (caption) {
    const assPath = path.join(tmp, 'cap.ass');
    writeFileSync(assPath, buildAss(caption, duration), 'utf8');
    vf += `,ass=${assPath}`;
  }
  vf += ',split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3';

  const args = ['-y', '-i', clipPath, '-t', String(duration), '-vf', vf, '-loop', '0', outPath];

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errChunks = [];
    proc.stderr.on('data', d => errChunks.push(d));
    proc.on('close', code => {
      if (code !== 0) reject(new RenderError('Failed to render GIF. The clip may be malformed.'));
      else resolve();
    });
  });

  return readFileSync(outPath);
}

export async function render(clipPath, caption, t0, t1, maxDuration = 4.0) {
  const duration = Math.min(t1 - t0, maxDuration);
  let gif;

  for (const [fps, width] of PROFILES) {
    gif = await encode(clipPath, caption, duration, fps, width);
    if (gif.length <= SIZE_LIMIT) return gif;
  }

  for (const dur of DURATION_STEPS) {
    if (dur >= duration) continue;
    gif = await encode(clipPath, caption, dur, ...PROFILES.at(-1));
    if (gif.length <= SIZE_LIMIT) return gif;
  }

  return gif; // deliver stage will CDN if still over
}

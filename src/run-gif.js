import { randomBytes } from 'crypto';

import { config } from './config.js';
import { SceneGifError } from './errors.js';
import { extract } from './pipeline/extract.js';
import { locate } from './pipeline/locate.js';
import { MAX_GIF_SECONDS, render } from './pipeline/render.js';
import { resolve } from './pipeline/resolve.js';
import { setSession } from './session-store.js';
import { formatTime } from './timecode.js';

const ATTACH_LIMIT = 10 * 1024 * 1024;
const SESSION_TTL = 900;

export function cid(action, videoId, t0, t1, sessionKey) {
  return `sg:${action}:${videoId}:${t0.toFixed(2)}:${t1.toFixed(2)}:${sessionKey}`;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function escapeMd(text) {
  return text.replace(/[\\*_~`|>[\]]/g, '\\$&');
}

function buildContent(source, t0, t1, windowIdx, isPublic) {
  const url = `https://youtu.be/${source.videoId}?t=${Math.floor(t0)}`;
  const link = `🎬 [${escapeMd(source.title)}](<${url}>)`;
  if (isPublic) return `-# ${link}`;

  const parts = [`${formatTime(t0)} → ${formatTime(t0 + Math.min(t1 - t0, MAX_GIF_SECONDS))}`];
  const match = windowIdx == null ? null : source.windows[windowIdx];
  if (!match) {
    parts.push('custom start');
  } else {
    const exact = Math.abs(match.start - t0) < 0.01 && Math.abs(match.end - t1) < 0.01;
    parts.push(`match ${windowIdx + 1} of ${source.windows.length}${exact ? '' : ' (nudged)'}`);
    if (match.text) parts.push(`“${escapeMd(truncate(match.text, 80))}”`);
  }
  return `${link}\n${parts.join(' · ')}`;
}

function buildComponents(source, t0, t1, sessionKey) {
  const c = action => cid(action, source.videoId, t0, t1, sessionKey);
  const rows = [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: '◀ -1s', custom_id: c('shift_back') },
        { type: 2, style: 2, label: '+1s ▶', custom_id: c('shift_fwd') },
        { type: 2, style: 2, label: '− shorter', custom_id: c('shorter') },
        { type: 2, style: 2, label: '+ longer', custom_id: c('longer') },
      ],
    },
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: '⏱ set start…', custom_id: c('start') },
        { type: 2, style: 1, label: '📤 post', custom_id: c('post') },
      ],
    },
  ];
  if (source.windows.length > 1) {
    rows.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: c('pick'),
        placeholder: `Jump to another match (${source.windows.length} found)`,
        options: source.windows.map((w, i) => ({
          label: `#${i + 1} · ${formatTime(w.start)}`,
          value: String(i),
          ...(w.text && { description: truncate(w.text, 100) }),
        })),
      }],
    });
  }
  return rows;
}

async function postGif(token, gifBytes, content, components) {
  const url = `${config.discordApiBase}/webhooks/${config.discordAppId}/${token}/messages/@original`;

  if (gifBytes.length <= ATTACH_LIMIT) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      content,
      components,
      attachments: [{ id: 0, filename: 'scene.gif' }],
    }));
    form.append('files[0]', new Blob([gifBytes], { type: 'image/gif' }), 'scene.gif');
    await fetch(url, { method: 'PATCH', body: form });
  } else {
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `${content}\n⚠️ GIF exceeded file size limit. Try a shorter duration.`,
        components,
      }),
    });
  }
}

async function postError(token, message) {
  const url = `${config.discordApiBase}/webhooks/${config.discordAppId}/${token}/messages/@original`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `❌ ${message}` }),
  });
}

async function findSource(scene) {
  const video = await resolve(scene);
  const windows = await locate(video.id, scene);
  return { videoId: video.id, title: video.title, duration: video.duration, windows };
}

export async function runGif(jobData) {
  const { scene, caption, token, isPublic = false } = jobData;
  let { source = null, t0 = null, t1 = null, windowIdx = 0, sessionKey = null } = jobData;

  try {
    source ??= await findSource(scene);
    if (t0 == null || t1 == null) {
      if (!source.windows[windowIdx]) windowIdx = 0;
      ({ start: t0, end: t1 } = source.windows[windowIdx]);
    }

    const clip = await extract(source.videoId, t0, t1);
    const gif = await render(clip, caption ?? null, t0, t1);

    sessionKey ??= randomBytes(8).toString('hex');
    if (!isPublic) setSession(sessionKey, { scene, caption, source, windowIdx }, SESSION_TTL);

    const content = buildContent(source, t0, t1, windowIdx, isPublic);
    const components = isPublic ? [] : buildComponents(source, t0, t1, sessionKey);
    await postGif(token, gif, content, components);
  } catch (err) {
    const msg = err instanceof SceneGifError ? err.userMessage : 'Something went wrong. Please try again.';
    if (!(err instanceof SceneGifError)) console.error('Unexpected error in runGif:', err);
    await postError(token, msg);
  }
}

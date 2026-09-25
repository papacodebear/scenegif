import { randomBytes } from 'crypto';

import { config } from './config.js';
import { SceneGifError } from './errors.js';
import { extract } from './pipeline/extract.js';
import { locate } from './pipeline/locate.js';
import { render } from './pipeline/render.js';
import { resolve } from './pipeline/resolve.js';
import { setSession } from './session-store.js';

const ATTACH_LIMIT = 10 * 1024 * 1024;

function cid(action, videoId, t0, t1, sessionKey) {
  return `sg:${action}:${videoId}:${t0.toFixed(2)}:${t1.toFixed(2)}:${sessionKey}`;
}

function buildComponents(videoId, t0, t1, sessionKey, winCount) {
  const c = action => cid(action, videoId, t0, t1, sessionKey);
  return [
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
        { type: 2, style: 2, label: '↻ next match', custom_id: c('next'), disabled: winCount <= 1 },
        { type: 2, style: 1, label: '📤 post', custom_id: c('post') },
      ],
    },
  ];
}

async function postGif(token, gifBytes, videoId, t0, t1, sessionKey, winCount) {
  const components = buildComponents(videoId, t0, t1, sessionKey, winCount);
  const url = `${config.discordApiBase}/webhooks/${config.discordAppId}/${token}/messages/@original`;

  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    components,
    attachments: [{ id: 0, filename: 'scene.gif' }],
  }));

  if (gifBytes.length <= ATTACH_LIMIT) {
    form.append('files[0]', new Blob([gifBytes], { type: 'image/gif' }), 'scene.gif');
    await fetch(url, { method: 'PATCH', body: form });
  } else {
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '⚠️ GIF exceeded file size limit. Try a shorter duration.' }),
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

export async function runGif(jobData) {
  const { scene, caption, token, channelId, windowIdx = 0 } = jobData;
  let { videoId = null, t0 = null, t1 = null } = jobData;

  try {
    if (!videoId) videoId = await resolve(scene);

    let allWindows = null;
    if (t0 == null || t1 == null) {
      let windows;
      [t0, t1, windows] = await locate(videoId, scene);
      allWindows = windows;
      if (windowIdx > 0 && windows.length > windowIdx) [t0, t1] = windows[windowIdx];
    }

    const clip = await extract(videoId, t0, t1);
    const gif = await render(clip, caption ?? null, t0, t1);

    const sessionKey = randomBytes(8).toString('hex');
    setSession(sessionKey, { scene, caption, windowIdx }, 900);

    const winCount = allWindows?.length ?? 1;
    await postGif(token, gif, videoId, t0, t1, sessionKey, winCount);
  } catch (err) {
    const msg = err instanceof SceneGifError ? err.userMessage : 'Something went wrong. Please try again.';
    if (!(err instanceof SceneGifError)) console.error('Unexpected error in runGif:', err);
    await postError(token, msg);
  }
}

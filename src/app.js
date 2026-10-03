import 'dotenv/config';

import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import express from 'express';
import pLimit from 'p-limit';

import { config } from './config.js';
import { warmupEmbedder } from './pipeline/locate.js';
import { MAX_GIF_SECONDS } from './pipeline/render.js';
import { checkRateLimit } from './rate-limit.js';
import { cid, runGif } from './run-gif.js';
import { getSession } from './session-store.js';
import { formatTime, parseTime } from './timecode.js';

const app = express();

// Caps concurrent yt-dlp/ffmpeg pipelines to avoid YouTube's datacenter throttling.
const limit = pLimit(3);
function enqueue(jobData) {
  limit(() => runGif(jobData)).catch(err => console.error('runGif failed:', err));
}

const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/interactions', verifyKeyMiddleware(config.discordPublicKey), async (req, res) => {
  const { type, data, token, channel_id, member, user } = req.body;

  if (type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }

  if (type === InteractionType.APPLICATION_COMMAND && data.name === 'scene') {
    const options = Object.fromEntries((data.options || []).map(o => [o.name, o.value]));
    const userId = BigInt((member?.user ?? user).id);

    if (!checkRateLimit(userId)) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "You're going too fast. Try again in a moment.", flags: InteractionResponseFlags.EPHEMERAL },
      });
    }

    enqueue({
      scene: options.scene,
      caption: options.caption ?? null,
      token,
      channelId: channel_id,
      windowIdx: 0,
    });

    return res.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL },
    });
  }

  if (type === InteractionType.MESSAGE_COMPONENT || type === InteractionType.MODAL_SUBMIT) {
    const customId = data.custom_id;
    if (!customId?.startsWith('sg:')) return res.sendStatus(400);

    const [, action, videoId, t0Str, t1Str, sessionKey] = customId.split(':', 5 + 1);
    let t0 = parseFloat(t0Str);
    let t1 = parseFloat(t1Str);

    const session = getSession(sessionKey);
    if (!session) return res.json(ephemeral('Session expired. Run /scene again.'));

    const { scene, caption, source } = session;
    let { windowIdx } = session;
    const job = { scene, caption, token, channelId: channel_id, source, sessionKey };

    if (action === 'post') {
      enqueue({ ...job, t0, t1, windowIdx, isPublic: true });
      return res.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
    }

    if (action === 'start') return res.json(startModal(videoId, t0, t1, sessionKey));

    if (action === 'start_submit') {
      const result = readStartModal(data, t0, t1, source.duration);
      if (result.error) return res.json(ephemeral(result.error));
      [t0, t1] = result.range;
      windowIdx = null;
    } else if (action === 'pick') {
      windowIdx = parseInt(data.values?.[0], 10);
      const match = source.windows[windowIdx];
      if (!match) return res.sendStatus(400);
      ({ start: t0, end: t1 } = match);
    } else {
      [t0, t1] = applyAction(action, t0, t1);
    }

    enqueue({ ...job, t0, t1, windowIdx });
    return res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  res.sendStatus(400);
});

function ephemeral(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: InteractionResponseFlags.EPHEMERAL },
  };
}

function startModal(videoId, t0, t1, sessionKey) {
  const length = Math.round(Math.min(t1 - t0, MAX_GIF_SECONDS) * 10) / 10;
  const input = (custom_id, label, value, placeholder) => ({
    type: 1,
    components: [{ type: 4, custom_id, style: 1, label, value, placeholder, required: custom_id === 'start', max_length: 12 }],
  });
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: cid('start_submit', videoId, t0, t1, sessionKey),
      title: 'Set start time',
      components: [
        input('start', 'Start time', formatTime(t0), 'e.g. 1:23 or 83.5'),
        input('length', `Length in seconds (max ${MAX_GIF_SECONDS})`, String(length), String(MAX_GIF_SECONDS)),
      ],
    },
  };
}

function readStartModal(data, t0, t1, videoDuration) {
  const fields = Object.fromEntries(
    data.components
      .flatMap(row => row.components ?? [row.component])
      .map(c => [c.custom_id, c.value?.trim() ?? '']),
  );

  const start = parseTime(fields.start ?? '');
  if (start == null) return { error: "Couldn't read that start time. Use m:ss or seconds, e.g. 1:23 or 83.5." };
  if (videoDuration && start >= videoDuration) {
    return { error: `That's past the end of the video (${formatTime(videoDuration)}).` };
  }

  const length = fields.length ? Number(fields.length) : t1 - t0;
  if (!(length > 0)) return { error: 'Length must be a positive number of seconds.' };

  let end = start + Math.min(length, MAX_GIF_SECONDS);
  if (videoDuration) end = Math.min(end, videoDuration);
  return { range: [start, end] };
}

function applyAction(action, t0, t1) {
  const dur = t1 - t0;
  if (action === 'shift_back') return [Math.max(0, t0 - 1), Math.max(1, t1 - 1)];
  if (action === 'shift_fwd') return [t0 + 1, t1 + 1];
  if (action === 'shorter') { const d = Math.min(0.5, Math.max(0, (dur - 1) / 2)); return [t0 + d, t1 - d]; }
  if (action === 'longer') return [Math.max(0, t0 - 0.5), t1 + 0.5];
  return [t0, t1];
}

await warmupEmbedder();
app.listen(PORT, () => console.log(`Listening on :${PORT}`));

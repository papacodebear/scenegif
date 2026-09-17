import 'dotenv/config';

import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { Queue } from 'bullmq';
import express from 'express';
import { Redis } from 'ioredis';

import { redisConnection } from './cache.js';
import { config } from './config.js';

const app = express();
const queue = new Queue('scenegif', { connection: redisConnection() });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

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

    if (!await checkRateLimit(userId)) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "You're going too fast. Try again in a moment.", flags: InteractionResponseFlags.EPHEMERAL },
      });
    }

    await queue.add('run_gif', {
      scene: options.scene,
      caption: options.caption ?? null,
      token,
      channelId: channel_id,
    });

    return res.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: InteractionResponseFlags.EPHEMERAL },
    });
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const customId = data.custom_id;
    if (!customId?.startsWith('sg:')) return res.sendStatus(400);

    const [, action, videoId, t0Str, t1Str, sessionKey] = customId.split(':', 5 + 1);
    const t0 = parseFloat(t0Str);
    const t1 = parseFloat(t1Str);

    const raw = await redis.get(`session:${sessionKey}`);
    if (!raw) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Session expired. Run /scene again.', flags: InteractionResponseFlags.EPHEMERAL },
      });
    }

    const session = JSON.parse(raw);
    const { scene, caption, windowIdx } = session;

    if (action === 'post') {
      await queue.add('run_gif', { scene, caption, token, channelId: channel_id, videoId, t0, t1, windowIdx });
      return res.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
    }

    const [newT0, newT1, newWinIdx] = applyAction(action, t0, t1, windowIdx);
    const jobData = { scene, caption, token, channelId: channel_id, videoId, windowIdx: newWinIdx };
    if (action !== 'next') Object.assign(jobData, { t0: newT0, t1: newT1 });

    await queue.add('run_gif', jobData);
    return res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  res.sendStatus(400);
});

function applyAction(action, t0, t1, winIdx) {
  const dur = t1 - t0;
  if (action === 'shift_back') return [Math.max(0, t0 - 1), Math.max(1, t1 - 1), winIdx];
  if (action === 'shift_fwd') return [t0 + 1, t1 + 1, winIdx];
  if (action === 'shorter') { const d = Math.min(0.5, Math.max(0, (dur - 1) / 2)); return [t0 + d, t1 - d, winIdx]; }
  if (action === 'longer') return [Math.max(0, t0 - 0.5), t1 + 0.5, winIdx];
  if (action === 'next') return [t0, t1, winIdx + 1];
  return [t0, t1, winIdx];
}

async function checkRateLimit(userId) {
  const key = `rl:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count <= config.rateLimitPerMin;
}

app.listen(PORT, () => console.log(`Gateway listening on :${PORT}`));

import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  discordToken: required('SCENEGIF_DISCORD_TOKEN'),
  discordAppId: required('SCENEGIF_DISCORD_APP_ID'),
  discordPublicKey: required('SCENEGIF_DISCORD_PUBLIC_KEY'),
  redisUrl: process.env.SCENEGIF_REDIS_URL || 'redis://localhost:6379',
  clipCacheDir: process.env.SCENEGIF_CLIP_CACHE_DIR || '/tmp/scenegif/clips',
  clipCacheMaxGb: parseFloat(process.env.SCENEGIF_CLIP_CACHE_MAX_GB || '10'),
  ytDlpCookies: process.env.SCENEGIF_YT_DLP_COOKIES || null,
  ytDlpPoToken: process.env.SCENEGIF_YT_DLP_PO_TOKEN || null,
  discordApiBase: 'https://discord.com/api/v10',
  rateLimitPerMin: parseInt(process.env.SCENEGIF_RATE_LIMIT_PER_MIN || '5', 10),
};

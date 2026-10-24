const VIDEO_ID = /^[\w-]{11}$/;

// Parses "83", "83s", "1m23s" or "1h2m3s" from a ?t= param; returns null if unreadable.
function parseOffset(value) {
  if (!value) return null;
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

// Extracts { videoId, t } from a YouTube URL or bare video ID; null if unrecognized.
export function parseYouTubeUrl(input) {
  const text = input.trim();
  if (VIDEO_ID.test(text)) return { videoId: text, t: null };

  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }

  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)?.[1];
  }
  if (!id || !VIDEO_ID.test(id)) return null;

  return { videoId: id, t: parseOffset(url.searchParams.get('t') ?? url.searchParams.get('start')) };
}

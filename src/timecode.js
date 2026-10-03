// Formats seconds as m:ss or h:mm:ss, keeping one decimal only when there is one.
export function formatTime(seconds) {
  const tenths = Math.round(seconds * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor(tenths / 600) % 60;
  const s = (tenths % 600) / 10;
  const ss = (s < 10 ? '0' : '') + (Number.isInteger(s) ? s : s.toFixed(1));
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Parses "83", "83.5", "1:23", "1:23.5" or "1:02:03"; returns null if unreadable.
export function parseTime(input) {
  const text = input.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some(p => p >= 60)) return null;
  return parts.reduce((total, p) => total * 60 + p, 0);
}

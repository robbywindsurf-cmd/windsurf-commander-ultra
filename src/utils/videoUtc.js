// videoUtc.js — parses the GoPro GPMF UTC timestamp format.
//
// gpmfWebView.js's GPSU parser produces "YYYYMMDDTHHMMSSZ" (basic ISO 8601,
// no dashes/colons) — e.g. "20250614T135300Z". `new Date(...)` only
// reliably parses *extended* ISO 8601 (with dashes/colons); V8 (dev/
// Metro) parses the basic form loosely, but JSC on a real device rejects
// it outright with "RangeError: Date value out of bounds". Insert the
// separators before handing it to Date so this works the same everywhere.

export function parseVideoStartUtc(videoStartUtc) {
  if (!videoStartUtc || videoStartUtc.length < 16) return null;
  const iso = `${videoStartUtc.slice(0, 4)}-${videoStartUtc.slice(4, 6)}-${videoStartUtc.slice(6, 8)}` +
    `T${videoStartUtc.slice(9, 11)}:${videoStartUtc.slice(11, 13)}:${videoStartUtc.slice(13, 15)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// videoStartUtc + an offset in seconds -> ISO timestamp, or null if
// videoStartUtc can't be parsed.
export function videoUtcPlusSeconds(videoStartUtc, seconds) {
  const start = parseVideoStartUtc(videoStartUtc);
  if (!start) return null;
  return new Date(start.getTime() + seconds * 1000).toISOString();
}

// SQLite's datetime('now') stores "YYYY-MM-DD HH:MM:SS" — UTC, no zone
// marker — and several screens were displaying that raw string straight
// to the rider (coaching report timestamp, "last computed"/"last indexed"
// times), showing UTC as if it were local time. In BST (UTC+1) that's a
// real hour off from the wall clock. Parses it as UTC, then formats using
// the device's own local timezone (DST-aware automatically, not a
// hardcoded +1) for display.
export function formatLocalTime(sqliteUtc) {
  if (!sqliteUtc) return null;
  const iso = sqliteUtc.includes('T') ? sqliteUtc : sqliteUtc.replace(' ', 'T');
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (Number.isNaN(d.getTime())) return sqliteUtc;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

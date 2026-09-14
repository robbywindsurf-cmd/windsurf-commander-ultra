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

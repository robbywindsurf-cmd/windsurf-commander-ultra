// mp4CreationTime.js
// Reads the standard MP4 `moov > mvhd` box's creation_time field directly
// — the same field smart_trim_360.py reads via
// `ffprobe -show_entries format_tags=creation_time`. This replaces relying
// solely on GPMF's embedded GPSU marker: gpmfExtractor.js only scans a
// fixed tail chunk of the file for a 'GPSU' text marker, which — since
// GPMF telemetry is interleaved throughout the whole recording, not
// concentrated at the end — was very likely finding a sample from late in
// the clip and mislabeling it as the *start* time. mvhd.creation_time is a
// single, fixed-position, unambiguous field.
//
// Caveat (matches smart_trim_360.py's own documented --bst flag): the
// camera's clock is set to UK local time, not UTC, so this field needs a
// timezone correction. Rather than requiring a manual flag, the correction
// is computed from the extracted date itself (UK's BST period is a fixed
// rule: last Sunday of March to last Sunday of October).

import * as FileSystem from 'expo-file-system/legacy';

const QT_EPOCH_OFFSET_S = 2082844800; // seconds between 1904-01-01 and 1970-01-01 (Unix epoch)
const TAIL_CHUNK_BYTES = 16 * 1024 * 1024; // generous — moov itself is only ever a few MB even with telemetry sample tables

function lastSundayUtc(year, monthIndex) {
  // monthIndex is 0-based (2 = March, 9 = October)
  const d = new Date(Date.UTC(year, monthIndex + 1, 0)); // last day of that month
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

// UK BST runs from 01:00 UTC on the last Sunday of March to 01:00 UTC on
// the last Sunday of October. `date` here has its Y/M/D/H/M/S fields
// correct (they came straight from the camera's clock) even though it's
// mislabeled as UTC — that's fine for this calendar-only check.
function isUkBst(date) {
  const year = date.getUTCFullYear();
  const start = lastSundayUtc(year, 2);
  start.setUTCHours(1, 0, 0, 0);
  const end = lastSundayUtc(year, 9);
  end.setUTCHours(1, 0, 0, 0);
  return date >= start && date < end;
}

// Walks MP4 boxes looking for a nested path (e.g. ['moov', 'mvhd']).
// Returns { offset, headerSize, size } for the matched box, or null.
function findBox(bytes, start, end, path) {
  let offset = start;
  while (offset + 8 <= end) {
    const size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);

    let boxSize = size;
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const hi = ((bytes[offset + 8] << 24) | (bytes[offset + 9] << 16) | (bytes[offset + 10] << 8) | bytes[offset + 11]) >>> 0;
      const lo = ((bytes[offset + 12] << 24) | (bytes[offset + 13] << 16) | (bytes[offset + 14] << 8) | bytes[offset + 15]) >>> 0;
      boxSize = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size === 0) {
      boxSize = end - offset;
    }
    if (boxSize < headerSize) break; // corrupt — avoid an infinite loop

    if (type === path[0]) {
      if (path.length === 1) return { offset, headerSize, size: boxSize };
      const inner = findBox(bytes, offset + headerSize, Math.min(end, offset + boxSize), path.slice(1));
      if (inner) return inner;
    }
    offset += boxSize;
  }
  return null;
}

// Returns a real UTC ISO string, or null if the box/field couldn't be
// found (e.g. moov wasn't inside the tail chunk read, or the field is
// zeroed/garbage).
export async function extractMp4CreationTime(fileUri) {
  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) return null;
    const fileSize = info.size;

    const length = Math.min(TAIL_CHUNK_BYTES, fileSize);
    const position = Math.max(0, fileSize - length);
    const base64 = await FileSystem.readAsStringAsync(fileUri, { encoding: 'base64', position, length });

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const mvhd = findBox(bytes, 0, bytes.length, ['moov', 'mvhd']);
    if (!mvhd) {
      console.warn('[MP4] moov/mvhd box not found in tail chunk');
      return null;
    }

    const body = mvhd.offset + mvhd.headerSize;
    const version = bytes[body];
    let creationTimeQt;
    if (version === 1) {
      const hi = ((bytes[body + 4] << 24) | (bytes[body + 5] << 16) | (bytes[body + 6] << 8) | bytes[body + 7]) >>> 0;
      const lo = ((bytes[body + 8] << 24) | (bytes[body + 9] << 16) | (bytes[body + 10] << 8) | bytes[body + 11]) >>> 0;
      creationTimeQt = hi * 4294967296 + lo;
    } else {
      creationTimeQt = ((bytes[body + 4] << 24) | (bytes[body + 5] << 16) | (bytes[body + 6] << 8) | bytes[body + 7]) >>> 0;
    }

    const unixSeconds = creationTimeQt - QT_EPOCH_OFFSET_S;
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
      console.warn('[MP4] creation_time field looks invalid:', creationTimeQt);
      return null;
    }

    const cameraLocalAsUtc = new Date(unixSeconds * 1000);
    const offsetHours = isUkBst(cameraLocalAsUtc) ? 1 : 0;
    const realUtc = new Date(cameraLocalAsUtc.getTime() - offsetHours * 3600000);

    // videoStartUtc is stored/consumed everywhere else (videoUtc.js,
    // filename patterns) as basic ISO 8601 ("YYYYMMDDTHHMMSSZ", no
    // dashes/colons) — match that instead of the extended form
    // toISOString() gives.
    const basicIso = realUtc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    console.log('[MP4] creation_time:', cameraLocalAsUtc.toISOString(), '(camera clock) ->', basicIso, `(UTC, BST offset ${offsetHours}h)`);
    return basicIso;
  } catch (err) {
    console.warn('[MP4] creation_time extraction failed:', err.message);
    return null;
  }
}

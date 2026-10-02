// gpmfExtractor.js
// React Native bridge between the GPMF extraction WebView and the rest of the app.
// Reads the last N bytes of a GoPro video file (where the moov/GPMF atom lives),
// sends it as base64 to the hidden WebView, and receives GPS start time back.
//
// Multi-user safe: this module is stateless per-request, no user data stored at module level.

import * as FileSystem from 'expo-file-system/legacy';

// ── STATE ─────────────────────────────────────────────────────────────────
let gpmfWebViewRef = null;
let isReady = false;
let pendingExtraction = null;

// ── REGISTRATION ──────────────────────────────────────────────────────────

export function registerGPMFWebView(ref) {
  gpmfWebViewRef = ref;
}

export function disposeGPMF() {
  isReady = false;
  gpmfWebViewRef = null;
  pendingExtraction = null;
}

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────
// Called by VideoScreen's onMessage prop on the GPMF WebView.

export function handleGPMFMessage(event) {
  try {
    const msg = JSON.parse(event.nativeEvent.data);

    if (msg.type === 'ready') {
      console.log('[GPMF] WebView ready');
      isReady = true;
      return;
    }

    if (msg.type === 'debug') {
      console.log('[GPMF debug]', msg.message);
      return;
    }

    if (msg.type === 'result') {
      console.log('[GPMF] GPS start UTC:', msg.videoStartUtc);
      if (msg.gpsPoints?.length > 0) {
        console.log('[GPMF] First GPS point:', JSON.stringify(msg.gpsPoints[0]));
      }
      if (pendingExtraction) {
        pendingExtraction.resolve({
          videoStartUtc: msg.videoStartUtc || null,
          gpsPoints: msg.gpsPoints || [],
        });
        pendingExtraction = null;
      }
      return;
    }

    if (msg.type === 'error') {
      console.warn('[GPMF] Error:', msg.message);
      if (pendingExtraction) {
        pendingExtraction.resolve(null);
        pendingExtraction = null;
      }
    }
  } catch (e) {
    console.warn('[GPMF] Failed to parse WebView message:', e.message);
  }
}

// ── MAIN EXTRACTION FUNCTION ──────────────────────────────────────────────
// Sends one chunk to the hidden WebView and resolves with its parse result
// ({ videoStartUtc, gpsPoints }) or null on timeout/error.

function askWebViewForChunk(base64, fileSize, chunkStart) {
  return new Promise((resolve) => {
    pendingExtraction = { resolve };

    gpmfWebViewRef.current.postMessage(JSON.stringify({
      type: 'extractGPS',
      base64,
      fileSize,
      chunkStart,
    }));

    // 30 second timeout — large files take longer to decode
    setTimeout(() => {
      if (pendingExtraction) {
        console.warn('[GPMF] Extraction timed out after 30s');
        pendingExtraction.resolve(null);
        pendingExtraction = null;
      }
    }, 30000);
  });
}

// Walks the file from the start for the earliest GPSU sample.
// Returns { videoStartUtc, gpsPoints } or null if extraction fails.

export async function extractVideoStartTime(fileUri) {
  if (!gpmfWebViewRef?.current) {
    console.warn('[GPMF] No WebView registered');
    return null;
  }

  if (!isReady) {
    console.warn('[GPMF] WebView not ready yet — waiting up to 10s...');
    // Wait up to 10 seconds for the WebView to become ready
    const startTime = Date.now();
    while (!isReady && Date.now() - startTime < 10000) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!isReady) {
      console.warn('[GPMF] WebView still not ready after 10s, skipping extraction');
      return null;
    }
    console.log('[GPMF] WebView became ready after', Date.now() - startTime, 'ms');
  }

  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) {
      console.warn('[GPMF] File not found:', fileUri);
      return null;
    }

    const fileSize = info.size;
    const fname = fileUri.split('/').pop() || '';

    // Walk forward from the start of the file until the earliest GPSU sample
    // is found. GPMF telemetry is interleaved throughout `mdat` in recording
    // order — `mdat` comes early in a GoPro .360's layout, with the `moov`
    // index atom at the very end — so the earliest GPSU marker is somewhere
    // near the start, but at a position that varies with the video bitrate
    // and the sample layout, not at a fixed offset. A real .360 (GS010117)
    // has its first GPSU at 8.61MB, just past a single 8MB read, which
    // returned nothing and left the import screen with no time to display.
    // Chunks are cheap to read but expensive to decode, so each one is first
    // checked in JS for the marker and only sent to the WebView if present.
    // Bounded, so a file with no telemetry costs a few reads rather than a
    // scan of the whole recording.
    const chunkSize = 8 * 1024 * 1024;
    const maxBytes = 48 * 1024 * 1024;

    for (let position = 0; position < Math.min(maxBytes, fileSize); position += chunkSize) {
      const length = Math.min(chunkSize, fileSize - position);

      const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: 'base64',
        position,
        length,
      });

      let hasMarker = true;
      try { hasMarker = atob(base64).includes('GPSU'); } catch { hasMarker = true; }
      if (!hasMarker) continue;

      console.log('[GPMF] Sending', Math.round(length / 1024 / 1024) + 'MB chunk at',
        Math.round(position / 1024 / 1024) + 'MB of', Math.round(fileSize / 1024 / 1024) + 'MB file:', fname);

      const result = await askWebViewForChunk(base64, fileSize, position);
      if (result?.videoStartUtc) return result;
    }

    console.warn('[GPMF] No GPSU found in the first', Math.round(maxBytes / 1024 / 1024) + 'MB of', fname);
    return null;

  } catch (err) {
    console.warn('[GPMF] Failed to read file chunk:', err.message);
    return null;
  }
}

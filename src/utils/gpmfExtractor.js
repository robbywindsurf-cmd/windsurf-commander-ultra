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
// Reads the last chunk of the video file and sends it to the WebView for parsing.
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
    const is360 = fname.toLowerCase().endsWith('.360');

    // Read from the START of the file, not the tail. GPMF telemetry
    // samples are interleaved throughout `mdat` in recording order —
    // `mdat` comes early in a GoPro .360's layout, with the `moov` index
    // atom at the very end. An earlier version of this code read the tail
    // specifically to find `moov` (true, that's where the index lives),
    // but that conflated the index's location with where the telemetry
    // *samples* live — reading the tail grabbed a real GPSU marker, just
    // one from late in the recording, silently mislabelling it as the
    // video's start time. The earliest GPSU marker — i.e. the true
    // satellite-derived start time — is near the start of the file. 8MB
    // (up from 2MB) gives margin past any header/thumbnail boxes before
    // mdat's telemetry begins.
    const chunkSize = 8 * 1024 * 1024;
    const position = 0;
    const length = Math.min(chunkSize, fileSize);

    console.log('[GPMF] Reading first', Math.round(length / 1024 / 1024) + 'MB of', Math.round(fileSize / 1024 / 1024) + 'MB file:', fname);

    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: 'base64',
      position,
      length,
    });

    console.log('[GPMF] Chunk read successfully, sending to WebView...');

    return new Promise((resolve) => {
      pendingExtraction = { resolve };

      gpmfWebViewRef.current.postMessage(JSON.stringify({
        type: 'extractGPS',
        base64,
        fileSize,
        chunkStart: position,
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

  } catch (err) {
    console.warn('[GPMF] Failed to read file chunk:', err.message);
    return null;
  }
}

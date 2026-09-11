// gpmfWebView.js
// GPMF telemetry extraction WebView — extracts GPS start time from
// GoPro MP4/360 files on iPhone using a minimal binary GPMF parser.
// Receives a base64 chunk of the file (last 2-5MB) via postMessage,
// parses the GPMF binary to find GPS UTC timestamp and GPS points.

export const GPMF_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body>
<script>

// ── GPMF BINARY PARSER ────────────────────────────────────────────────────
// Parses GPMF KLV (Key-Length-Value) binary format directly.
// GPMF format: 4-byte key, 1-byte type, 1-byte size, 2-byte repeat, then data.
// All values are big-endian.

function parseGPMFForGPS(dataView) {
  let offset = 0;
  let utc = null;
  let points = [];

  try {
    while (offset < dataView.byteLength - 8) {
      // Read 4-char key
      const key = String.fromCharCode(
        dataView.getUint8(offset),
        dataView.getUint8(offset + 1),
        dataView.getUint8(offset + 2),
        dataView.getUint8(offset + 3)
      );
      const type = String.fromCharCode(dataView.getUint8(offset + 4));
      const size = dataView.getUint8(offset + 5);
      const repeat = dataView.getUint16(offset + 6, false); // big-endian
      const dataSize = size * repeat;

      if (key === 'GPSU' && type === 'U') {
        // GPS UTC timestamp — format: YYMMDDHHMMSS.SSS
        const chars = [];
        for (let i = 0; i < Math.min(16, dataSize); i++) {
          chars.push(String.fromCharCode(dataView.getUint8(offset + 8 + i)));
        }
        const timeStr = chars.join('');
        if (timeStr.length >= 12) {
          const yr = '20' + timeStr.slice(0, 2);
          const mo = timeStr.slice(2, 4);
          const dy = timeStr.slice(4, 6);
          const hr = timeStr.slice(6, 8);
          const mn = timeStr.slice(8, 10);
          const sc = timeStr.slice(10, 12);
          utc = yr + mo + dy + 'T' + hr + mn + sc + 'Z';
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'debug',
            message: 'Found GPSU: ' + utc
          }));
        }
      }

      if (key === 'GPS5' && type === 'l' && size >= 20) {
        // GPS5: lat, lon, alt, speed2d, speed3d — each int32 scaled
        for (let i = 0; i < repeat; i++) {
          const base = offset + 8 + i * size;
          if (base + 20 <= dataView.byteLength) {
            const lat = dataView.getInt32(base, false) / 10000000;
            const lon = dataView.getInt32(base + 4, false) / 10000000;
            const alt = dataView.getInt32(base + 8, false) / 1000;
            const speed = dataView.getInt32(base + 12, false) / 1000;
            if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) {
              points.push({ lat, lon, alt, speed_ms: speed });
            }
          }
        }
        if (points.length > 0) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'debug',
            message: 'Found GPS5 points: ' + points.length
          }));
        }
      }

      // Advance to next GPMF element — padded to 4-byte boundary
      const totalSize = 8 + dataSize;
      const paddedSize = Math.ceil(totalSize / 4) * 4;
      if (paddedSize === 0) break; // safety guard
      offset += paddedSize;
    }
  } catch (e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'debug',
      message: 'GPMF parse exception at offset ' + offset + ': ' + e.message
    }));
  }

  if (utc || points.length > 0) {
    return { utc, points };
  }
  return null;
}

// ── MAIN EXTRACTION FUNCTION ──────────────────────────────────────────────
// Receives a base64-encoded chunk of the video file (last 2-5MB),
// decodes it, and scans for GPMF GPS data.

async function extractGPSFromBase64(base64, fileSize, chunkStart) {
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'debug',
      message: 'Decoding base64 chunk (' + base64.length + ' chars), file size: ' + fileSize + ', chunk starts at: ' + chunkStart
    }));

    // Decode base64 to binary
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'debug',
      message: 'Chunk decoded: ' + bytes.length + ' bytes. Scanning for GPMF...'
    }));

    // Scan the chunk for GPMF data — look for 'DEVC' or 'GPSU' or 'GPS5' markers
    const dataView = new DataView(bytes.buffer);
    let result = null;

    // Try parsing from the start of the chunk
    result = parseGPMFForGPS(dataView);

    // If not found, scan for GPMF markers within the chunk
    if (!result) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'debug',
        message: 'Direct parse failed, scanning for GPMF markers...'
      }));

      for (let i = 0; i < bytes.length - 4; i++) {
        const marker = String.fromCharCode(bytes[i], bytes[i+1], bytes[i+2], bytes[i+3]);
        if (marker === 'GPSU' || marker === 'GPS5' || marker === 'DEVC') {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'debug',
            message: 'Found marker ' + marker + ' at offset ' + i + ', parsing from here...'
          }));
          const subView = new DataView(bytes.buffer, i);
          result = parseGPMFForGPS(subView);
          if (result) break;
        }
      }
    }

    if (result) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'result',
        videoStartUtc: result.utc || null,
        gpsPoints: (result.points || []).slice(0, 5)
      }));
    } else {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'result',
        videoStartUtc: null,
        gpsPoints: [],
        message: 'No GPMF GPS data found in chunk — try a larger chunk or raw file'
      }));
    }

  } catch (err) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'error',
      message: 'Extraction failed: ' + err.message + ' | ' + (err.stack || '')
    }));
  }
}

// ── MESSAGE LISTENERS ─────────────────────────────────────────────────────
// iOS uses document.addEventListener, Android uses window.addEventListener.
// Include both for compatibility.

function handleMessage(e) {
  try {
    const msg = JSON.parse(e.data);
    if (msg.type === 'extractGPS') {
      extractGPSFromBase64(msg.base64, msg.fileSize, msg.chunkStart);
    }
  } catch (err) {
    // Ignore parse errors
  }
}

document.addEventListener('message', handleMessage);
window.addEventListener('message', handleMessage);

// Signal ready to React Native
window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));

</script>
</body>
</html>`;

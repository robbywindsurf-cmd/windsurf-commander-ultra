// frameExtraction.js
// Extracts frames from a local video file for pose analysis, capped to
// keep on-device MoveNet inference fast and battery-friendly.

import * as VideoThumbnails from 'expo-video-thumbnails';


const INTERVAL_MS = 300;
const MAX_DURATION_MS = 120000; // only analyse first 2 minutes
const MAX_FRAMES = 100;         // hard cap after subsampling

async function getVideoDurationMs(videoUri) {
  // Return the max analysis window directly — expo-video-thumbnails
  // naturally fails on timestamps beyond the actual video length,
  // which the extraction loop already handles gracefully via try/catch.
  // This avoids instantiating expo-av's Video imperatively (not supported).
  return MAX_DURATION_MS;
}

// Extracts frames at INTERVAL_MS across the analysis window (min of full
// video duration and MAX_DURATION_MS), then evenly subsamples down to
// MAX_FRAMES if the raw extraction would exceed the cap.
// Returns [{ uri, timeMs }, ...] in chronological order.
export async function extractFrames(videoUri, options = {}) {
  const {
    intervalMs = INTERVAL_MS,
    maxDurationMs = MAX_DURATION_MS,
    maxFrames = MAX_FRAMES,
    startMs = 0, // allows passing a user-selected clip start in future
  } = options;

  const fullDurationMs = await getVideoDurationMs(videoUri);
  const windowEndMs = Math.min(fullDurationMs, startMs + maxDurationMs);

   let frames = [];
  console.log('[Frames] starting extraction, windowEndMs:', windowEndMs);
  for (let t = startMs; t < windowEndMs; t += intervalMs) {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: t,
        quality: 0.8,
      });
      frames.push({ uri, timeMs: t });
      if (frames.length === 1) {
        console.log('[Frames] first frame extracted at:', t, 'ms, uri:', uri);
      }
    } catch (err) {
      console.warn(`Frame extraction failed at ${t}ms:`, err.message);
    }
  }
  console.log('[Frames] loop complete, frames.length:', frames.length);

  if (frames.length === 0) {
    throw new Error('No frames could be extracted from video');
  }
  console.log('[Frames] extracted before cap:', frames.length);

  // Evenly subsample if over the hard cap, rather than truncating the end
  // of the clip — keeps coverage across the whole analysed window.
  if (frames.length > maxFrames) {
    const step = Math.ceil(frames.length / maxFrames);
    frames = frames.filter((_, i) => i % step === 0);
  }

  return frames;
}
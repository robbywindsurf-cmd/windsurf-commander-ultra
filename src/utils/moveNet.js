// moveNet.js
// Bridge between React Native and the MoveNet WebView.
// Supports auto-tracking with constrained search window.

import * as FileSystem from 'expo-file-system/legacy';

let webviewRef = null;
let isReady = false;
let pendingFrames = {};
let frameCounter = 0;

export function registerWebView(ref) {
  webviewRef = ref;
}

export function handleWebViewMessage(event) {
  try {
    const msg = JSON.parse(event.nativeEvent.data);

    if (msg.type === 'ready') {
      console.log('[MoveNet] WebView detector ready');
      isReady = true;
      return;
    }

    if (msg.type === 'result') {
      const pending = pendingFrames[msg.frameId];
      if (pending) {
        pending.resolve({
          keypoints:      msg.keypoints      || null,
          annotatedFrame: msg.annotatedFrame || null,
          nextTheta:      msg.nextTheta      ?? null,
          nextPhi:        msg.nextPhi        ?? null,
        });
        delete pendingFrames[msg.frameId];
      }
      return;
    }

    if (msg.type === 'error') {
      console.warn('[MoveNet] WebView error:', msg.message);
      const pending = pendingFrames[msg.frameId];
      if (pending) {
        pending.resolve({ keypoints: null, annotatedFrame: null, nextTheta: null, nextPhi: null });
        delete pendingFrames[msg.frameId];
      }
      return;
    }

    if (msg.type === 'debug') {
      console.log('[MoveNet WebView debug]', msg.message);
      return;
    }
  } catch (e) {
    console.warn('[MoveNet] Failed to parse WebView message:', e.message);
  }
}

function waitForReady(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (isReady) { resolve(); return; }
    const interval = setInterval(() => {
      if (isReady) { clearInterval(interval); resolve(); }
    }, 200);
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error('MoveNet WebView timed out'));
    }, timeoutMs);
  });
}

// initialTheta/initialPhi = anchor from user tap (constrains tracking window)
// theta/phi = current tracking angles (updated each frame)
export async function runPoseDetectionOnFrame(
  framePath,
  theta = null,
  phi = null,
  initialTheta = null,
  initialPhi = null
) {
  if (!webviewRef) {
    console.warn('[MoveNet] No WebView registered');
    return null;
  }

  await waitForReady();

  const base64  = await FileSystem.readAsStringAsync(framePath, { encoding: 'base64' });
  const frameId = `frame_${frameCounter++}`;

  return new Promise((resolve) => {
    pendingFrames[frameId] = { resolve };

    webviewRef.current?.postMessage(JSON.stringify({
      type:           'processFrame',
      base64,
      frameId,
      theta,
      phi,
      initialTheta,
      initialPhi,
      useReproject:    theta !== null && phi !== null,
      returnAnnotated: true,
    }));

    setTimeout(() => {
      if (pendingFrames[frameId]) {
        console.warn('[MoveNet] Frame timed out:', frameId);
        pendingFrames[frameId].resolve({
          keypoints: null, annotatedFrame: null, nextTheta: null, nextPhi: null
        });
        delete pendingFrames[frameId];
      }
    }, 10000);
  });
}

export function disposeDetector() {
  isReady = false;
  webviewRef = null;
  pendingFrames = {};
}

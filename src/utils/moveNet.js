// moveNet.js
// Bridge between React Native and the MoveNet WebView.
// Supports auto-tracking with constrained search window.

import * as FileSystem from 'expo-file-system/legacy';
import { trace } from '@commandersuite/core';

let webviewRef = null;
let isReady = false;
let pendingFrames = {};
let frameCounter = 0;

// Diagnostics for the pose pipeline. Everything here previously went to
// console.log/warn, which reaches nothing at all in a Release build — so a run
// that produced *zero* detected frames looked identical to a run that worked,
// and the frame_data row just said 0. These counters exist so a silent failure
// leaves evidence that can be pulled off the device.
let mountedAt = null;
const diag = {
  readyMs: null,
  initErrors: 0,
  framesSent: 0,
  framesReplied: 0,
  framesTimedOut: 0,
  nullKeypoints: 0,
  frameErrors: 0,
};

export function getMoveNetDiag() {
  return { ...diag, isReady };
}

export function resetMoveNetDiag() {
  diag.readyMs = null;
  diag.initErrors = 0;
  diag.framesSent = 0;
  diag.framesReplied = 0;
  diag.framesTimedOut = 0;
  diag.nullKeypoints = 0;
  diag.frameErrors = 0;
}

export function registerWebView(ref) {
  webviewRef = ref;
  mountedAt = Date.now();
}

export function handleWebViewMessage(event) {
  try {
    const msg = JSON.parse(event.nativeEvent.data);

    if (msg.type === 'ready') {
      console.log('[MoveNet] WebView detector ready');
      isReady = true;
      diag.readyMs = mountedAt != null ? Date.now() - mountedAt : null;
      trace(`[MoveNet] detector ready in ${diag.readyMs}ms`);
      return;
    }

    if (msg.type === 'result') {
      diag.framesReplied++;
      if (!msg.keypoints) diag.nullKeypoints++;
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
      // No frameId means the failure happened during detector init, which
      // poisons every frame that follows — worth a trace line of its own.
      if (msg.frameId == null) {
        diag.initErrors++;
        trace(`[MoveNet] INIT ERROR: ${msg.message}`);
      } else {
        diag.frameErrors++;
      }
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

  diag.framesSent++;
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
        diag.framesTimedOut++;
        // Log the first, then sparsely: a dead detector times out on every
        // single frame, and 100 identical lines would just rotate the useful
        // earlier context out of the trace.
        if (diag.framesTimedOut === 1 || diag.framesTimedOut % 25 === 0) {
          trace(`[MoveNet] frame timeout #${diag.framesTimedOut} (frame ${frameId})`);
        }
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
  mountedAt = null;
}

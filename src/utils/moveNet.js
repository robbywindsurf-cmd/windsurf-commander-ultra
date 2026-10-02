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
  // Subset of nullKeypoints the continuity gate suppressed: it found a pose but
  // judged it a different subject. Distinct from the detector finding nothing.
  gateRejected: 0,
  frameErrors: 0,
};

export function getMoveNetDiag() {
  return { ...diag, isReady };
}

export function resetMoveNetDiag() {
  // readyMs deliberately survives: it describes when the current WebView's
  // detector initialised, and an analysis usually starts long after that. The
  // first run on build 8 reported readyMs=null alongside isReady=true, which
  // reads like a failed init — it was only ever this reset clearing a value the
  // 'ready' event had already supplied. It is re-armed on the next mount.
  diag.initErrors = 0;
  diag.framesSent = 0;
  diag.framesReplied = 0;
  diag.framesTimedOut = 0;
  diag.nullKeypoints = 0;
  diag.gateRejected = 0;
  diag.frameErrors = 0;
}

export function registerWebView(ref) {
  webviewRef = ref;
  mountedAt = Date.now();
  // A new mount means a new detector, so the previous init timing no longer
  // describes anything.
  diag.readyMs = null;
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
      // A frame can come back without keypoints either because the detector
      // found no pose in it, or because the continuity gate rejected the pose it
      // did find as a different subject. Those say opposite things about whether
      // the gate is working, and reporting them as one number left a run of 100
      // rejections indistinguishable from a run of 100 empty frames — which is
      // exactly the ambiguity behind the unexplained GS010112 20/100 against
      // GS010113's 99/100. nullKeypoints stays the total; gateRejected is the
      // part of it the gate suppressed.
      const gateAction = (msg.trackingAction === 'reset' ||
        (typeof msg.trackingAction === 'string' && msg.trackingAction.indexOf('rejected') === 0))
        ? msg.trackingAction : null;
      if (!msg.keypoints) {
        diag.nullKeypoints++;
        if (gateAction) diag.gateRejected++;
      }
      const pending = pendingFrames[msg.frameId];
      if (pending) {
        pending.resolve({
          keypoints:      msg.keypoints      || null,
          annotatedFrame: msg.annotatedFrame || null,
          nextTheta:      msg.nextTheta      ?? null,
          nextPhi:        msg.nextPhi        ?? null,
          trackingAction: msg.trackingAction ?? null,
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

// Clears the continuity gate's memory inside the WebView. The gate keeps a
// reference rider size and a last-good position for the whole life of the
// WebView, and the WebView is mounted once and reused across analyses — the
// trace shows a single "detector ready" line serving several runs. Without this,
// each analysis inherits the previous clip's reference size, so a clip whose
// rider sits at a different apparent distance is rejected wholesale. That is a
// plausible cause of a 0/100 run that reports no reason at all.
//
// Safe to call before the WebView is up: a fresh WebView has fresh state anyway.
export function resetTracker() {
  try {
    webviewRef?.current?.postMessage(JSON.stringify({ type: 'resetTracking' }));
  } catch (err) {
    console.warn('[MoveNet] resetTracker failed:', err.message);
  }
}

// poseAnalysisPipeline.js
// Orchestrates: extract frames -> MoveNet (auto-tracking) -> angles -> save locally (SQLite).
// Adapted from the production Oracle-webhook pipeline: Free tier has no
// Oracle sync, so results are written straight to commander-core's
// AnalysisRepository instead of POSTed to windsurf-pose-coaching.

import { AnalysisRepository } from '@commandersuite/core';
import { extractFrames } from './frameExtraction';
import { runPoseDetectionOnFrame } from './moveNet';
import { analyseFrame } from './angleCalculations';

function avg(frameResults, key) {
  const vals = frameResults
    .filter((r) => r.detected)
    .map((r) => r[key])
    .filter((v) => v !== null && v !== undefined);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

export async function analyseSessionVideo({
  videoUri,
  sessionId,
  board,
  notes,
  riderProfile,
  onProgress,
  onFrame,
  onStatus,
  videoStartUtc,
  startMs,
  riderTheta,
  riderPhi,
  fname,
}) {
  console.log('[Pipeline] starting, sessionId:', sessionId);
  console.log('[Pipeline] initial angles: theta=', riderTheta, 'phi=', riderPhi);

  onStatus?.('Extracting frames…');

  const frames = await extractFrames(videoUri, { startMs: startMs || 0 });
  console.log('[Pipeline] frames extracted:', frames.length);

  onStatus?.('Starting analysis…');

  const frameResults = [];

  const initialTheta = riderTheta !== null && riderTheta !== undefined ? riderTheta : null;
  const initialPhi = riderPhi !== null && riderPhi !== undefined ? riderPhi : null;

  let currentTheta = initialTheta;
  let currentPhi = initialPhi;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];

    const result = await runPoseDetectionOnFrame(
      frame.uri,
      currentTheta,
      currentPhi,
      initialTheta,
      initialPhi
    );

    const keypoints = result?.keypoints || null;
    const annotatedFrame = result?.annotatedFrame || null;

    if (result?.nextTheta !== null && result?.nextTheta !== undefined) {
      currentTheta = result.nextTheta;
      currentPhi = result.nextPhi;
    }

    const timeS = Math.round(frame.timeMs / 1000);
    if (!keypoints) {
      frameResults.push({ time_s: timeS, detected: false });
    } else {
      const measurements = analyseFrame(keypoints, riderProfile);
      frameResults.push({ time_s: timeS, detected: true, ...measurements });
    }

    onProgress?.(i + 1, frames.length);
    onFrame?.(annotatedFrame);
  }

  const detectedCount = frameResults.filter((r) => r.detected).length;
  console.log('[Pipeline] detected:', detectedCount, '/', frameResults.length);

  onStatus?.('Saving results…');

  // Map frame_results' angle field names onto the frame_data schema
  // (back_angle, left/right knee+elbow — no ankle columns in frame_data).
  const framesForDb = frameResults.map((r) => ({
    detected: r.detected,
    time_s: r.time_s,
    utc_timestamp: videoStartUtc ? null : null,
    left_knee_angle: r.left_knee_angle ?? null,
    right_knee_angle: r.right_knee_angle ?? null,
    back_angle: r.back_angle_from_vertical ?? null,
    left_elbow_angle: r.left_elbow_angle ?? null,
    right_elbow_angle: r.right_elbow_angle ?? null,
  }));

  const analysisId = await AnalysisRepository.insertAnalysis({
    session_id: sessionId,
    video_start_utc: videoStartUtc || null,
    fname: fname || null,
    frames_total: frameResults.length,
    frames_detected: detectedCount,
    left_knee_avg: avg(frameResults, 'left_knee_angle'),
    right_knee_avg: avg(frameResults, 'right_knee_angle'),
    back_angle_avg: avg(frameResults, 'back_angle_from_vertical'),
    left_elbow_avg: avg(frameResults, 'left_elbow_angle'),
    right_elbow_avg: avg(frameResults, 'right_elbow_angle'),
    left_ankle_avg: avg(frameResults, 'left_ankle_angle_from_vertical'),
    right_ankle_avg: avg(frameResults, 'right_ankle_angle_from_vertical'),
  });

  await AnalysisRepository.insertFrames(analysisId, sessionId, framesForDb);

  console.log('[Pipeline] saved analysis', analysisId, 'for session', sessionId);

  return {
    analysisId,
    sessionId,
    framesTotal: frameResults.length,
    framesDetected: detectedCount,
    notes: notes || null,
    board: board || null,
  };
}

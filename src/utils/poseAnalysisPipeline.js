// poseAnalysisPipeline.js
// Orchestrates: extract frames -> MoveNet (auto-tracking) -> angles -> save locally (SQLite).
// Adapted from the production Oracle-webhook pipeline: Free tier has no
// Oracle sync, so results are written straight to commander-core's
// AnalysisRepository instead of POSTed to windsurf-pose-coaching.

import {
  AnalysisRepository, SessionRepository, CoachingService, UsageLimits,
  RiderProfileService, BLEService, calculateForces, calculateForcesWithIMU,
} from '@commandersuite/core';
import { extractFrames } from './frameExtraction';
import { runPoseDetectionOnFrame } from './moveNet';
import { analyseFrame } from './angleCalculations';
import { videoUtcPlusSeconds } from './videoUtc';

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
  onProgress,
  onFrame,
  onStatus,
  videoStartUtc,
  startMs,
  riderTheta,
  riderPhi,
  fname,
  userTier = 'free',
}) {
  console.log('[Pipeline] starting, sessionId:', sessionId);
  console.log('[Pipeline] initial angles: theta=', riderTheta, 'phi=', riderPhi);

  onStatus?.('Extracting frames…');

  const frames = await extractFrames(videoUri, { startMs: startMs || 0 });
  console.log('[Pipeline] frames extracted:', frames.length);

  // Height/weight for both the joint-angle scale factor (analyseFrame) and
  // ForceCalculator's biomechanics — see RiderProfileService for the
  // fallback priority (user_profile -> latest weight_log -> 75kg/175cm
  // defaults). *IsDefault flags let the frame review warn when a default
  // was used rather than the rider's real numbers.
  const riderProfile = await RiderProfileService.resolve();

  onStatus?.('Starting analysis…');

  const frameResults = [];
  let firstDetectedFrame = null;

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
    let measurements = null;
    let forces = null;
    const trackingAction = result?.trackingAction ?? null;
    const avgTorsoConfidence = result?.avgTorsoConfidence ?? null;

    if (!keypoints) {
      frameResults.push({ time_s: timeS, detected: false, trackingAction, avgTorsoConfidence });
    } else {
      measurements = analyseFrame(keypoints, riderProfile);

      // ForceCalculator needs GPS speed at this instant — correlated here
      // (rather than reusing insertFrames' own correlation further down)
      // so the live frame-review preview (onFrame below) shows the same
      // numbers that end up persisted, without waiting on the DB write.
      const utcTimestamp = videoUtcPlusSeconds(videoStartUtc, timeS);
      const gpsPoint = utcTimestamp
        ? await AnalysisRepository.correlateFrameToGPS(sessionId, utcTimestamp)
        : null;
      const conditions = { speed_kn: gpsPoint?.speed_kn ?? 0, boom_height_cm: 130 };

      const imuReading = BLEService.isConnected() ? BLEService.getLatestReading() : null;
      forces = imuReading
        ? calculateForcesWithIMU(keypoints, riderProfile, conditions, imuReading)
        : calculateForces(keypoints, riderProfile, conditions);

      frameResults.push({
        time_s: timeS, detected: true, trackingAction, avgTorsoConfidence,
        ...measurements,
        front_foot_pct: forces.frontFootPct,
        back_foot_pct: forces.backFootPct,
        fin_load_kg: forces.finLoadKg,
        leg_length_cm: forces.legLengthCm,
        arm_span_cm: forces.armSpanCm,
        imu_connected: forces.imuConnected,
        total_g_force: forces.totalGForce,
        stability_pct: forces.stabilityPct,
      });
      if (!firstDetectedFrame && annotatedFrame) firstDetectedFrame = annotatedFrame;
    }

    onProgress?.(i + 1, frames.length);
    onFrame?.(annotatedFrame, timeS, measurements ? {
      leftKneeAngle: measurements.left_knee_angle ?? null,
      rightKneeAngle: measurements.right_knee_angle ?? null,
      backAngle: measurements.back_angle_from_vertical ?? null,
      forces,
    } : null);
  }

  const detectedCount = frameResults.filter((r) => r.detected).length;
  console.log('[Pipeline] detected:', detectedCount, '/', frameResults.length);

  onStatus?.('Saving results…');

  // Map frame_results' angle field names onto the frame_data schema
  // (back_angle, left/right knee+elbow — no ankle columns in frame_data).
  const framesForDb = frameResults.map((r) => ({
    detected: r.detected,
    time_s: r.time_s,
    // Was always null regardless of videoStartUtc (`videoStartUtc ? null :
    // null`) — nothing that correlates frames to trackpoints/GPS by time
    // (AnalysisRepository.getNearestFrame, correlateFrameToGPS) could ever
    // have matched anything against frame_data as a result. videoStartUtc
    // itself is GPMF's basic-ISO "YYYYMMDDTHHMMSSZ" — see videoUtc.js for
    // why that can't go straight into `new Date(...)`.
    utc_timestamp: videoUtcPlusSeconds(videoStartUtc, r.time_s),
    left_knee_angle: r.left_knee_angle ?? null,
    right_knee_angle: r.right_knee_angle ?? null,
    back_angle: r.back_angle_from_vertical ?? null,
    left_elbow_angle: r.left_elbow_angle ?? null,
    right_elbow_angle: r.right_elbow_angle ?? null,
    front_foot_pct: r.front_foot_pct ?? null,
    back_foot_pct: r.back_foot_pct ?? null,
    fin_load_kg: r.fin_load_kg ?? null,
    leg_length_cm: r.leg_length_cm ?? null,
    arm_span_cm: r.arm_span_cm ?? null,
    imu_connected: r.imu_connected ? 1 : 0,
    total_g_force: r.total_g_force ?? null,
    stability_pct: r.stability_pct ?? null,
  }));

  const analysisData = {
    left_knee_avg: avg(frameResults, 'left_knee_angle'),
    right_knee_avg: avg(frameResults, 'right_knee_angle'),
    back_angle_avg: avg(frameResults, 'back_angle_from_vertical'),
    left_elbow_avg: avg(frameResults, 'left_elbow_angle'),
    right_elbow_avg: avg(frameResults, 'right_elbow_angle'),
    left_ankle_avg: avg(frameResults, 'left_ankle_angle_from_vertical'),
    right_ankle_avg: avg(frameResults, 'right_ankle_angle_from_vertical'),
  };

  // Free tier (BASIC_BIOMECHANICS): the pipeline still runs in full and the
  // caller gets the angle averages back for an on-screen summary, but
  // nothing is written to AnalysisRepository — no analysis history, no
  // coaching, matching "free tier does not get saved history".
  let analysisId = null;
  if (userTier !== 'free') {
    analysisId = await AnalysisRepository.insertAnalysis({
      session_id: sessionId,
      video_start_utc: videoStartUtc || null,
      fname: fname || null,
      frames_total: frameResults.length,
      frames_detected: detectedCount,
      last_frame_base64: firstDetectedFrame,
      ...analysisData,
    });

    await AnalysisRepository.insertFrames(analysisId, sessionId, framesForDb);

    console.log('[Pipeline] saved analysis', analysisId, 'for session', sessionId);
  }

  // Free tier: angles only (BASIC_BIOMECHANICS, unlimited), no coaching.
  // Premium/ultimate: generate a coaching report against their FULL_ANALYSIS
  // monthly cap — still saves the angle data above even once that cap is hit,
  // just skips the coaching text and doesn't consume more quota.
  let coachingReport = null;
  if (userTier !== 'free') {
    const withinLimit = await UsageLimits.withinLimit('FULL_ANALYSIS', userTier);
    if (withinLimit) {
      onStatus?.('Generating coaching report…');
      try {
        const session = await SessionRepository.getById(sessionId);
        // Only real when this session also has a FIT-file GPS track —
        // insertFrames() above already correlated each frame's speed_kn
        // against trackpoints, so this is just reading that back out.
        const speedSummary = analysisId ? await AnalysisRepository.getFrameSpeedSummary(analysisId) : null;
        coachingReport = await CoachingService.generateCoaching(session || {}, analysisData, userTier, speedSummary);
        if (coachingReport) {
          await AnalysisRepository.insertCoachingNote({
            session_id: sessionId,
            analysis_id: analysisId,
            report_text: coachingReport,
            key_findings: null,
            source: userTier === 'ultimate' ? 'cloud_rag' : 'local_llm',
          });
          await UsageLimits.recordUsage('FULL_ANALYSIS');
        }
      } catch (err) {
        console.warn('[Pipeline] coaching generation failed:', err.message);
      }
    } else {
      onStatus?.('Monthly coaching limit reached — angles saved, no report this time.');
    }
  }

  return {
    analysisId,
    sessionId,
    framesTotal: frameResults.length,
    framesDetected: detectedCount,
    weightIsDefault: riderProfile.weightIsDefault,
    heightIsDefault: riderProfile.heightIsDefault,
    notes: notes || null,
    board: board || null,
    coachingReport,
    ...analysisData,
  };
}

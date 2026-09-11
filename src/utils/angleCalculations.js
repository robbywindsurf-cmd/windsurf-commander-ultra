// angleCalculations.js
// Ports pose_biomechanics.py's angle/scaling logic to JS, so mobile-analysed
// sessions produce numbers directly comparable to the Mac pipeline's output.
// Keypoint input format: [[x, y, confidence], ...] — 17 COCO keypoints,
// same order as returned by runPoseDetectionOnFrame in moveNet.js.

// ── COCO KEYPOINT INDICES ──────────────────────────────────────────────
const NOSE = 0;
const L_EYE = 1, R_EYE = 2;
const L_EAR = 3, R_EAR = 4;
const L_SHOULDER = 5, R_SHOULDER = 6;
const L_ELBOW = 7, R_ELBOW = 8;
const L_WRIST = 9, R_WRIST = 10;
const L_HIP = 11, R_HIP = 12;
const L_KNEE = 13, R_KNEE = 14;
const L_ANKLE = 15, R_ANKLE = 16;

const CONFIDENCE_THRESHOLD = 0.3;

// ── GEOMETRY HELPERS ─────────────────────────────────────────────────

// Angle at point p2, formed by segments p2->p1 and p2->p3.
// e.g. knee angle: p1=hip, p2=knee, p3=ankle.
function angleBetween(p1, p2, p3) {
  const v1 = [p1[0] - p2[0], p1[1] - p2[1]];
  const v2 = [p3[0] - p2[0], p3[1] - p2[1]];

  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  const mag1 = Math.sqrt(v1[0] ** 2 + v1[1] ** 2);
  const mag2 = Math.sqrt(v2[0] ** 2 + v2[1] ** 2);

  if (mag1 === 0 || mag2 === 0) return null;

  const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return radToDeg(Math.acos(cosAngle));
}

function pixelDistance(p1, p2) {
  if (!p1 || !p2) return null;
  return Math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2);
}

// Angle of the top->bottom segment from vertical. 0° = upright, 90° = horizontal.
function leanAngleFromVertical(pTop, pBottom) {
  const dx = pBottom[0] - pTop[0];
  const dy = pBottom[1] - pTop[1];
  if (dy === 0) return 90.0;
  return radToDeg(Math.atan(Math.abs(dx) / Math.abs(dy)));
}

function radToDeg(rad) {
  return (rad * 180) / Math.PI;
}

function round1(v) {
  return v === null || v === undefined ? v : Math.round(v * 10) / 10;
}

// ── SCALING ───────────────────────────────────────────────────────────

// Returns { scaleCmPerPx, method } or { scaleCmPerPx: null, method: null }
// if no calibration reference is available in this frame.
// Priority: inside leg (direct measurement) > arm span > height (roughest).
function getScaleFactor(keypoints, riderProfile) {
  const kp = (idx) => {
    if (idx >= keypoints.length) return null;
    const pt = keypoints[idx];
    if (pt.length >= 3 && pt[2] < CONFIDENCE_THRESHOLD) return null;
    if (pt[0] === 0 && pt[1] === 0) return null;
    return [pt[0], pt[1]];
  };

  const { inside_leg_cm: insideLegCm, height_cm: heightCm, arm_span_cm: armSpanCm } = riderProfile || {};

  // Priority 1 — inside leg via hip-knee-ankle pixel chain
  if (insideLegCm) {
    for (const [hipI, kneeI, ankleI, side] of [
      [L_HIP, L_KNEE, L_ANKLE, 'L'],
      [R_HIP, R_KNEE, R_ANKLE, 'R'],
    ]) {
      const hip = kp(hipI), knee = kp(kneeI), ankle = kp(ankleI);
      if (hip && knee && ankle) {
        const legPx = pixelDistance(hip, knee) + pixelDistance(knee, ankle);
        if (legPx > 0) {
          return { scaleCmPerPx: insideLegCm / legPx, method: `inside_leg_${side}` };
        }
      }
    }
  }

  // Priority 2 — arm span via wrist-to-wrist
  if (armSpanCm) {
    const lw = kp(L_WRIST), rw = kp(R_WRIST);
    if (lw && rw) {
      const spanPx = pixelDistance(lw, rw);
      if (spanPx > 0) {
        return { scaleCmPerPx: armSpanCm / spanPx, method: 'arm_span' };
      }
    }
  }

  // Priority 3 — rough estimate via height (shoulder-to-ankle proxy)
  if (heightCm) {
    const lSh = kp(L_SHOULDER), lAn = kp(L_ANKLE);
    if (lSh && lAn) {
      const approxPx = pixelDistance(lSh, lAn) / 0.72; // shoulder ~72% of height
      if (approxPx > 0) {
        return { scaleCmPerPx: heightCm / approxPx, method: 'height_estimate' };
      }
    }
  }

  return { scaleCmPerPx: null, method: null };
}

// ── MAIN ANALYSIS ────────────────────────────────────────────────────

// keypoints: 17 [x, y, confidence] triples (same order as runPoseDetectionOnFrame output)
// riderProfile: { height_cm, inside_leg_cm, arm_span_cm, weight_kg } — all optional
export function analyseFrame(keypoints, riderProfile = null) {
  const kp = (idx) => {
    if (idx >= keypoints.length) return null;
    const pt = keypoints[idx];
    if (pt.length >= 3 && pt[2] < CONFIDENCE_THRESHOLD) return null;
    if (pt[0] === 0 && pt[1] === 0) return null;
    return [pt[0], pt[1]];
  };

  const lShoulder = kp(L_SHOULDER), rShoulder = kp(R_SHOULDER);
  const lElbow = kp(L_ELBOW), rElbow = kp(R_ELBOW);
  const lWrist = kp(L_WRIST), rWrist = kp(R_WRIST);
  const lHip = kp(L_HIP), rHip = kp(R_HIP);
  const lKnee = kp(L_KNEE), rKnee = kp(R_KNEE);
  const lAnkle = kp(L_ANKLE), rAnkle = kp(R_ANKLE);

  const result = {
    left_knee_angle: null,
    right_knee_angle: null,
    left_elbow_angle: null,
    right_elbow_angle: null,
    left_ankle_angle_from_vertical: null,
    right_ankle_angle_from_vertical: null,
    back_angle_from_vertical: null,
    shoulder_hip_lean: null,
    stance_width_px: null,
    stance_width_cm: null,
    front_back_knee_ratio: null,
    scale_cm_per_px: null,
    scale_method: null,
  };

  // Knee angles (hip-knee-ankle)
  if (lHip && lKnee && lAnkle) {
    result.left_knee_angle = angleBetween(lHip, lKnee, lAnkle);
  }
  if (rHip && rKnee && rAnkle) {
    result.right_knee_angle = angleBetween(rHip, rKnee, rAnkle);
  }

  // Elbow angles (shoulder-elbow-wrist)
  if (lShoulder && lElbow && lWrist) {
    result.left_elbow_angle = angleBetween(lShoulder, lElbow, lWrist);
  }
  if (rShoulder && rElbow && rWrist) {
    result.right_elbow_angle = angleBetween(rShoulder, rElbow, rWrist);
  }

  // Back/body lean angle
  if (lShoulder && rShoulder && lHip && rHip) {
    const shoulderMid = [(lShoulder[0] + rShoulder[0]) / 2, (lShoulder[1] + rShoulder[1]) / 2];
    const hipMid = [(lHip[0] + rHip[0]) / 2, (lHip[1] + rHip[1]) / 2];
    result.back_angle_from_vertical = leanAngleFromVertical(shoulderMid, hipMid);
    result.shoulder_hip_lean = shoulderMid[0] - hipMid[0];
  }

  // Stance width (ankle to ankle)
  if (lAnkle && rAnkle) {
    result.stance_width_px = pixelDistance(lAnkle, rAnkle);
  }

  // Front/back knee bend ratio
  if (result.left_knee_angle && result.right_knee_angle) {
    result.front_back_knee_ratio = round1(result.left_knee_angle / result.right_knee_angle);
  }

  // Ankle angle — geometric proxy only, NOT force/pressure through the fin.
  if (lKnee && lAnkle) {
    result.left_ankle_angle_from_vertical = leanAngleFromVertical(lKnee, lAnkle);
  }
  if (rKnee && rAnkle) {
    result.right_ankle_angle_from_vertical = leanAngleFromVertical(rKnee, rAnkle);
  }

  // Anthropometric scaling
  if (riderProfile) {
    const { scaleCmPerPx, method } = getScaleFactor(keypoints, riderProfile);
    if (scaleCmPerPx) {
      result.scale_cm_per_px = round1(scaleCmPerPx * 10000) / 10000; // matches Python's round(scale, 4)
      result.scale_method = method;
      if (result.stance_width_px) {
        result.stance_width_cm = round1(result.stance_width_px * scaleCmPerPx);
      }
    }
  }

  // Round all numeric measurements to 1 decimal place
  for (const k of Object.keys(result)) {
    if (typeof result[k] === 'number') {
      result[k] = round1(result[k]);
    }
  }

  return result;
}

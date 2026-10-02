// movenetWebView.js
// MoveNet inference WebView with:
// 1. Equirectangular → perspective re-projection
// 2. Auto-tracking toward the rider, with a continuity gate (apparent size and
//    position must stay plausible for the same rider) and a ±20° horizontal /
//    ±15° vertical safety window around the initial tap
// 3. Colour-coded skeleton overlay with bounding box

export const MOVENET_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js"></script>
</head>
<body>
  <canvas id="canvas" style="display:none"></canvas>
  <canvas id="perspCanvas" style="display:none"></canvas>
  <img id="frame" style="display:none" />
  <script>
    var detector  = null;
    var isReady   = false;

    var DEFAULT_THETA    = 90;
    var DEFAULT_PHI      = -70;
    var FOV              = 100;
    var OUT_WIDTH        = 960;
    var OUT_HEIGHT       = 720;
    var TRACKING_SMOOTH  = 0.75;
    var WINDOW_THETA     = 20;
    var WINDOW_PHI       = 15;
    var MIN_TRACKING_CONFIDENCE = 0.4;
    var MAX_DELTA_PER_FRAME     = 5; // degrees
    var MAX_MISSES_BEFORE_RESET = 5;
    var consecutiveMisses = 0;

    // Continuity gate. The Python original (rider_extract_360.py) used YOLOv8n-
    // pose and picked the highest-confidence *person*, so it could reject a
    // detection outright when nobody scored above 0.4. MoveNet SINGLEPOSE always
    // returns keypoints and scores them per-joint, not per-person, so there is
    // nothing to say "this is not the rider" — which is how tracking drifts onto
    // distant objects.
    //
    // The rider's apparent size is the discriminator that replaces it: a distant
    // object projects a far smaller torso span than the rider you started on.
    // Measured as the pixel height of confidently-detected keypoints, compared
    // against a slow-moving reference of the accepted detections so far.
    var MIN_RIDER_SIZE_RATIO   = 0.6;
    var MAX_RIDER_SIZE_RATIO   = 1.6;
    // A successive detection more than half a frame width away is a different
    // subject, not the rider. Fraction of OUT_WIDTH rather than a fixed pixel
    // count so it tracks any future change to the output size.
    var MAX_CENTROID_JUMP_FRAC = 0.5;
    var riderSizeRef   = null;
    var lastAcceptedCx = null;
    var lastAcceptedCy = null;
    // Consecutive resets with no accepted detection in between. Used as an
    // escape hatch below — see noteReset().
    var MAX_RESET_STREAK = 3;
    var resetStreak = 0;

    // ── Skeleton ──────────────────────────────────────────────────────────
    var SEGMENTS = [
      { pairs: [[0,1],[0,2],[1,3],[2,4]], color: '#00ff88' },
      { pairs: [[5,6]], color: '#aa00ff' },
      { pairs: [[5,7],[7,9]], color: '#0088ff' },
      { pairs: [[6,8],[8,10]], color: '#ff4400' },
      { pairs: [[5,11],[6,12],[11,12]], color: '#aa00ff' },
      { pairs: [[11,13],[13,15]], color: '#ff8800' },
      { pairs: [[12,14],[14,16]], color: '#ff8800' },
    ];

    function drawSkeleton(ctx, keypoints, minScore) {
      minScore = minScore || 0.25;
      ctx.lineWidth = 3;
      for (var si = 0; si < SEGMENTS.length; si++) {
        var seg = SEGMENTS[si];
        ctx.strokeStyle = seg.color;
        for (var pi = 0; pi < seg.pairs.length; pi++) {
          var a = seg.pairs[pi][0], b = seg.pairs[pi][1];
          var kpA = keypoints[a], kpB = keypoints[b];
          if (!kpA || !kpB || kpA[2] < minScore || kpB[2] < minScore) continue;
          ctx.beginPath();
          ctx.moveTo(kpA[0], kpA[1]);
          ctx.lineTo(kpB[0], kpB[1]);
          ctx.stroke();
        }
      }
      for (var i = 0; i < keypoints.length; i++) {
        var kp = keypoints[i];
        if (!kp || kp[2] < minScore) continue;
        var colour = i < 5 ? '#00ff88' : i < 11 ? '#0088ff' : '#ff8800';
        ctx.beginPath();
        ctx.arc(kp[0], kp[1], 5, 0, 2 * Math.PI);
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      var visible = keypoints.filter(function(kp) { return kp && kp[2] >= minScore; });
      if (visible.length > 0) {
        var xs = visible.map(function(kp) { return kp[0]; });
        var ys = visible.map(function(kp) { return kp[1]; });
        var x1 = Math.min.apply(null, xs) - 10;
        var y1 = Math.min.apply(null, ys) - 10;
        var x2 = Math.max.apply(null, xs) + 10;
        var y2 = Math.max.apply(null, ys) + 10;
        ctx.strokeStyle = '#0088ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        var avgConf = visible.reduce(function(s, kp) { return s + kp[2]; }, 0) / visible.length;
        ctx.fillStyle = '#0088ff';
        ctx.fillRect(x1, y1 - 24, 120, 24);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 16px Arial';
        ctx.fillText('person ' + avgConf.toFixed(2), x1 + 4, y1 - 6);
      }
    }

    // ── Rider centroid ────────────────────────────────────────────────────
    function getRiderCentroid(keypoints, minScore) {
      minScore = minScore || 0.25;
      var torsoIdx = [5, 6, 11, 12];
      var visible = [];
      for (var i = 0; i < torsoIdx.length; i++) {
        var kp = keypoints[torsoIdx[i]];
        if (kp && kp[2] >= minScore) visible.push(kp);
      }
      if (visible.length < 2) {
        visible = keypoints.filter(function(kp) { return kp && kp[2] >= minScore; });
      }
      if (visible.length === 0) return null;
      var cx = visible.reduce(function(s, kp) { return s + kp[0]; }, 0) / visible.length;
      var cy = visible.reduce(function(s, kp) { return s + kp[1]; }, 0) / visible.length;
      return { cx: cx, cy: cy };
    }

    // ── Torso confidence ──────────────────────────────────────────────────
    function getTorsoConfidence(keypoints) {
      var torsoIdx = [5, 6, 11, 12];
      var torsoConfs = torsoIdx.map(function(i) {
        return (keypoints[i] && keypoints[i][2]) || 0;
      });
      var avgConf = torsoConfs.reduce(function(a, b) { return a + b; }, 0) / torsoConfs.length;
      var detectedCount = torsoConfs.filter(function(c) { return c >= MIN_TRACKING_CONFIDENCE; }).length;
      return { avgConf: avgConf, detectedCount: detectedCount };
    }

    // ── Rider apparent size ───────────────────────────────────────────────
    // Torso length: the vertical distance between the mid-shoulder and
    // mid-hip points, requiring all four torso joints (5, 6, 11, 12) — the
    // same four the confidence gate already insists on.
    //
    // Earlier this spanned *every* confident keypoint, which was wrong: that
    // distance changes with whichever joints MoveNet happens to find, so
    // gaining an ankle or losing a wrist looked like the rider changing size
    // and rejected otherwise-good frames. Torso length depends only on joints
    // that must already be present to reach this point, so it moves only when
    // the rider's apparent size really does.
    function getRiderSize(keypoints) {
      var torsoIdx = [5, 6, 11, 12];
      for (var i = 0; i < torsoIdx.length; i++) {
        var kp = keypoints[torsoIdx[i]];
        if (!kp || kp[2] < MIN_TRACKING_CONFIDENCE) return null;
      }
      var shoulderY = (keypoints[5][1] + keypoints[6][1]) / 2;
      var hipY      = (keypoints[11][1] + keypoints[12][1]) / 2;
      var h = Math.abs(hipY - shoulderY);
      return h > 0 ? { h: h } : null;
    }

    function noteReset() {
      // Position memory is per-subject: after losing the rider, the next
      // accepted detection can legitimately be anywhere in the frame.
      lastAcceptedCx = null;
      lastAcceptedCy = null;
      // The size reference deliberately SURVIVES a reset. Clearing it here is a
      // trap worth naming: the next detection would then have nothing to be
      // measured against, so it would be accepted unconditionally and set the
      // reference to its own size — meaning a tracker that reset away from a
      // distant object would re-adopt that same object one frame later. Keeping
      // the reference is what makes the wrong subject stay rejected.
      resetStreak++;
      if (resetStreak >= MAX_RESET_STREAK) {
        // Escape hatch. Repeated resets with no accepted detection in between
        // means the reference is probably wrong rather than the detections — the
        // rider really is at a different apparent distance — so start fresh
        // instead of rejecting forever.
        //
        // The trade-off, stated plainly: once this clears the reference, the
        // next detection is adopted unconditionally, so a subject that has been
        // rejected for the whole streak can become the new reference. Reaching
        // here needs MAX_RESET_STREAK full reset cycles first (5 misses each, so
        // ~20 unproductive frames), and the alternative is recording nothing at
        // all for the rest of the clip. It is the lesser evil, not a guarantee.
        riderSizeRef = null;
        resetStreak = 0;
      }
    }

    // ── Update tracking angles ────────────────────────────────────────────
    function updateTrackingAngles(centroid, keypoints, currentTheta, currentPhi, anchorTheta, anchorPhi) {
      var torso = getTorsoConfidence(keypoints);

      // Require at least 2 of 4 torso keypoints above confidence threshold
      var torsoFound = torso.detectedCount >= 2 && torso.avgConf >= MIN_TRACKING_CONFIDENCE;

      if (!centroid || !torsoFound) {
        consecutiveMisses++;
        if (consecutiveMisses >= MAX_MISSES_BEFORE_RESET) {
          consecutiveMisses = 0;
          noteReset();
          return {
            nextTheta: anchorTheta, nextPhi: anchorPhi,
            trackingAction: 'reset', avgTorsoConfidence: torso.avgConf,
            // accepted stays true here: a low-confidence frame is unchanged
            // behaviour, and the caller has always reported its keypoints. Only
            // the continuity gate below asserts positively that the detection is
            // a different subject, and only that suppresses keypoints.
            accepted: true
          };
        }
        return {
          nextTheta: currentTheta, nextPhi: currentPhi,
          trackingAction: 'held', avgTorsoConfidence: torso.avgConf,
          accepted: true
        };
      }

      // ── Continuity gate ─────────────────────────────────────────────────
      var size = getRiderSize(keypoints);
      var rejected = null;
      if (size && riderSizeRef !== null &&
          (size.h < riderSizeRef * MIN_RIDER_SIZE_RATIO || size.h > riderSizeRef * MAX_RIDER_SIZE_RATIO)) {
        rejected = 'rejected_size';
      }
      if (!rejected && lastAcceptedCx !== null) {
        var jumpX = centroid.cx - lastAcceptedCx;
        var jumpY = centroid.cy - lastAcceptedCy;
        if (Math.sqrt(jumpX * jumpX + jumpY * jumpY) > OUT_WIDTH * MAX_CENTROID_JUMP_FRAC) {
          rejected = 'rejected_position';
        }
      }

      if (rejected) {
        consecutiveMisses++;
        if (consecutiveMisses >= MAX_MISSES_BEFORE_RESET) {
          consecutiveMisses = 0;
          noteReset();
          return {
            nextTheta: anchorTheta, nextPhi: anchorPhi,
            trackingAction: 'reset', avgTorsoConfidence: torso.avgConf,
            accepted: false
          };
        }
        return {
          nextTheta: currentTheta, nextPhi: currentPhi,
          trackingAction: rejected, avgTorsoConfidence: torso.avgConf,
          accepted: false
        };
      }

      var offsetX  = centroid.cx - OUT_WIDTH  / 2;
      var offsetY  = centroid.cy - OUT_HEIGHT / 2;
      var degPerPx = FOV / OUT_WIDTH;

      var newTheta = currentTheta + offsetX * degPerPx * (1 - TRACKING_SMOOTH);
      var newPhi   = currentPhi   - offsetY * degPerPx * (1 - TRACKING_SMOOTH);

      // Reject sudden jumps — hold current position instead. Counted as a miss
      // (it did not before): a detection that has to be rejected as implausible
      // is not trustworthy, so it should be able to drive the anchor reset.
      // Without that the counter only ever saw *absent* detections, and a
      // tracker locked onto a confidently-wrong subject could hold there
      // indefinitely without ever reaching MAX_MISSES_BEFORE_RESET.
      var deltaTheta = newTheta - currentTheta;
      var deltaPhi   = newPhi   - currentPhi;
      if (Math.abs(deltaTheta) > MAX_DELTA_PER_FRAME || Math.abs(deltaPhi) > MAX_DELTA_PER_FRAME) {
        consecutiveMisses++;
        return {
          nextTheta: currentTheta, nextPhi: currentPhi,
          trackingAction: 'rejected_jump', avgTorsoConfidence: torso.avgConf,
          accepted: true
        };
      }

      consecutiveMisses = 0;
      resetStreak = 0;
      // Commit continuity state only for a detection that passed every gate,
      // so a rejected one cannot drag the reference size or last-good position
      // onto itself.
      if (size) {
        riderSizeRef = riderSizeRef === null ? size.h : riderSizeRef * 0.8 + size.h * 0.2;
      }
      lastAcceptedCx = centroid.cx;
      lastAcceptedCy = centroid.cy;

      // Constrain to search window around initial tap
      if (anchorTheta !== null && anchorTheta !== undefined) {
        newTheta = Math.max(anchorTheta - WINDOW_THETA, Math.min(anchorTheta + WINDOW_THETA, newTheta));
      }
      if (anchorPhi !== null && anchorPhi !== undefined) {
        newPhi = Math.max(anchorPhi - WINDOW_PHI, Math.min(anchorPhi + WINDOW_PHI, newPhi));
      }

      // Upper bound is 0, not 85: the camera is boom-end mounted, so the rider
      // is always at or below boom level. rider_extract_360.py clamped here too
      // (max(-85, min(0, last_phi))); allowing +85 let tracking aim at the sky,
      // where the only thing to detect is cloud or a distant building.
      newPhi = Math.max(-85, Math.min(0, newPhi));
      return {
        nextTheta: newTheta, nextPhi: newPhi,
        trackingAction: 'updated', avgTorsoConfidence: torso.avgConf,
        accepted: true
      };
    }

    // ── Equirectangular → perspective ─────────────────────────────────────
    // fovParam is optional — omit for the default FOV=100° wide pass; pass a
    // smaller value for the tight-crop second pass in processFrame.
    function equirectangularToPerspective(srcCanvas, theta, phi, fovParam) {
      var useFov  = (fovParam !== undefined && fovParam !== null) ? fovParam : FOV;
      var srcW = srcCanvas.width, srcH = srcCanvas.height;
      var srcCtx  = srcCanvas.getContext('2d');
      var srcData = srcCtx.getImageData(0, 0, srcW, srcH);
      var src     = srcData.data;

      var outCanvas = document.getElementById('perspCanvas');
      outCanvas.width  = OUT_WIDTH;
      outCanvas.height = OUT_HEIGHT;
      var outCtx  = outCanvas.getContext('2d');
      var outData = outCtx.createImageData(OUT_WIDTH, OUT_HEIGHT);
      var out     = outData.data;

      var fovRad   = useFov  * Math.PI / 180;
      var thetaRad = theta   * Math.PI / 180;
      var phiRad   = phi     * Math.PI / 180;
      var halfW    = Math.tan(fovRad / 2);
      var halfH    = halfW * OUT_HEIGHT / OUT_WIDTH;
      var cosT = Math.cos(thetaRad), sinT = Math.sin(thetaRad);
      var cosP = Math.cos(phiRad),   sinP = Math.sin(phiRad);

      for (var py = 0; py < OUT_HEIGHT; py++) {
        for (var px = 0; px < OUT_WIDTH; px++) {
          var xn = (px / (OUT_WIDTH  - 1)) * 2 * halfW - halfW;
          var yn = halfH - (py / (OUT_HEIGHT - 1)) * 2 * halfH;
          var norm  = Math.sqrt(xn*xn + yn*yn + 1);
          var xNorm = xn/norm, yNorm = yn/norm, zNorm = 1/norm;
          var xR =  cosT * xNorm + sinT * zNorm;
          var yR =  yNorm;
          var zR = -sinT * xNorm + cosT * zNorm;
          var xF = xR, yF = cosP * yR - sinP * zR, zF = sinP * yR + cosP * zR;
          var lon = Math.atan2(xF, zF);
          var lat = Math.asin(Math.max(-1, Math.min(1, yF)));
          var u = Math.round(((lon / (2 * Math.PI)) + 0.5) * (srcW - 1));
          var v = Math.round((0.5 - lat / Math.PI) * (srcH - 1));
          var uC = Math.max(0, Math.min(srcW - 1, u));
          var vC = Math.max(0, Math.min(srcH - 1, v));
          var si2 = (vC * srcW + uC) * 4;
          var oi  = (py * OUT_WIDTH + px) * 4;
          out[oi] = src[si2]; out[oi+1] = src[si2+1]; out[oi+2] = src[si2+2]; out[oi+3] = 255;
        }
      }
      outCtx.putImageData(outData, 0, 0);
      return outCanvas;
    }

    // ── Init ──────────────────────────────────────────────────────────────
    async function init() {
      try {
        await tf.setBackend('webgl');
        await tf.ready();
        detector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          { modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER, enableSmoothing: false }
        );
        isReady = true;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
      } catch (err) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: 'Init: ' + err.message }));
      }
    }

    // ── Process frame ─────────────────────────────────────────────────────
    async function processFrame(base64, frameId, useReproject, theta, phi, initialTheta, initialPhi) {
      try {
        var img    = document.getElementById('frame');
        var canvas = document.getElementById('canvas');
        var ctx    = canvas.getContext('2d');

        await new Promise(function(resolve, reject) {
          img.onload = resolve;
          img.onerror = function() { reject(new Error('img load failed')); };
          img.src = 'data:image/jpeg;base64,' + base64;
        });

        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);

        var currentTheta  = (theta        !== null && theta        !== undefined) ? theta        : DEFAULT_THETA;
        var currentPhi    = (phi          !== null && phi          !== undefined) ? phi          : DEFAULT_PHI;
        var anchorTheta   = (initialTheta !== null && initialTheta !== undefined) ? initialTheta : currentTheta;
        var anchorPhi     = (initialPhi   !== null && initialPhi   !== undefined) ? initialPhi   : currentPhi;

        var inferenceCanvas = canvas;
        if (useReproject && canvas.width > canvas.height * 1.5) {
          inferenceCanvas = equirectangularToPerspective(canvas, currentTheta, currentPhi);
        }

        var poses = await detector.estimatePoses(inferenceCanvas, { flipHorizontal: false });

        if (!poses || poses.length === 0) {
          var missAngles = updateTrackingAngles(null, [], currentTheta, currentPhi, anchorTheta, anchorPhi);
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'result', frameId: frameId,
            keypoints: null, annotatedFrame: null,
            nextTheta: missAngles.nextTheta, nextPhi: missAngles.nextPhi,
            trackingAction: missAngles.trackingAction,
            avgTorsoConfidence: missAngles.avgTorsoConfidence
          }));
          return;
        }

        var keypoints = poses[0].keypoints.map(function(kp) {
          return [kp.x, kp.y, kp.score || 0];
        });

        var centroid   = getRiderCentroid(keypoints, 0.25);
        var nextAngles = updateTrackingAngles(centroid, keypoints, currentTheta, currentPhi, anchorTheta, anchorPhi);

        // ── Tight-crop second pass ─────────────────────────────────────────
        // Mirrors rider_extract_360.py: after a successful wide-FOV detection,
        // compute the rider's angular bounding-box height and re-project at a
        // tighter FOV so MoveNet sees a larger, detail-rich view of the rider.
        // Tracking angles (nextTheta/nextPhi) always come from the first pass;
        // keypoints and annotatedFrame come from whichever pass was better.
        //
        // Only active for equirectangular footage (useReproject + wide aspect
        // ratio) where the rider typically appears small at FOV=100°, and only
        // when tracking has converged ('updated') so the centroid is reliable.
        //
        // Python constants reproduced here:
        //   PAD_TOP = 1.2  (sail height above rider body)
        //   PAD_BOTTOM = 0.8  (board below)
        //   +0.5  (baseline buffer)
        //   => expand_fov = box_h_deg * 3.5, clamped 40–140°
        var finalKeypoints  = keypoints;
        var finalCanvas     = inferenceCanvas;
        var cropFov         = FOV;

        var isEquirect = useReproject && canvas.width > canvas.height * 1.5;
        if (isEquirect && nextAngles.trackingAction === 'updated') {
          var visKps = keypoints.filter(function(kp) { return kp && kp[2] >= 0.25; });
          if (visKps.length >= 4) {
            var kpYs   = visKps.map(function(kp) { return kp[1]; });
            var boxH_px  = Math.max.apply(null, kpYs) - Math.min.apply(null, kpYs);
            var boxH_deg = boxH_px * (FOV / OUT_HEIGHT);
            var expandFov = Math.max(40, Math.min(140, boxH_deg * 3.5));

            // Only pay the cost of a second re-projection when the tight crop
            // is meaningfully narrower (rider small enough to benefit).
            if (expandFov < FOV * 0.85) {
              // Re-project at tight FOV centred on current tracking direction.
              // (perspCanvas is safely reused — first-pass inference is done.)
              var tightCanvas = equirectangularToPerspective(
                canvas, currentTheta, currentPhi, expandFov
              );
              var poses2 = await detector.estimatePoses(tightCanvas, { flipHorizontal: false });
              if (poses2 && poses2.length > 0) {
                var kp2 = poses2[0].keypoints.map(function(k2) {
                  return [k2.x, k2.y, k2.score || 0];
                });
                // Adopt tight-crop keypoints only if quality is maintained
                // (at least as many visible joints as the wide pass).
                var vis2 = kp2.filter(function(k2) { return k2[2] >= 0.25; });
                if (vis2.length >= visKps.length) {
                  finalKeypoints = kp2;
                  finalCanvas    = tightCanvas;
                  cropFov        = expandFov;
                }
              }
            }
          }
        }

        // A detection the continuity gate rejected is not the rider, so its
        // keypoints must never reach the analysis. poseAnalysisPipeline records
        // a null-keypoints frame as detected:false and skips biomechanics, which
        // is the correct outcome — otherwise a distant object gets persisted as
        // this rider's knee angles and foot pressures, which is worse than the
        // drift itself.
        if (!nextAngles.accepted) {
          finalKeypoints = null;
          finalCanvas    = null;
        }

        var annotatedFrame = null;
        if (finalCanvas) {
          var infCtx = finalCanvas.getContext('2d');
          drawSkeleton(infCtx, finalKeypoints, 0.25);
          annotatedFrame = finalCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({
          type:               'result',
          frameId:            frameId,
          keypoints:          finalKeypoints,
          annotatedFrame:     annotatedFrame,
          nextTheta:          nextAngles.nextTheta,
          nextPhi:            nextAngles.nextPhi,
          trackingAction:     nextAngles.trackingAction,
          avgTorsoConfidence: nextAngles.avgTorsoConfidence,
          cropFov:            cropFov,
        }));

      } catch (err) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'error', frameId: frameId, message: err.message
        }));
      }
    }

    // ── Message listener ──────────────────────────────────────────────────
    function handleMessage(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'resetTracking') {
          consecutiveMisses = 0;
          resetStreak = 0;
          riderSizeRef = null;
          lastAcceptedCx = null;
          lastAcceptedCy = null;
        }
        if (msg.type === 'processFrame') {
          processFrame(
            msg.base64,
            msg.frameId,
            msg.useReproject !== false,
            msg.theta        !== undefined ? msg.theta        : null,
            msg.phi          !== undefined ? msg.phi          : null,
            msg.initialTheta !== undefined ? msg.initialTheta : null,
            msg.initialPhi   !== undefined ? msg.initialPhi   : null
          );
        }
      } catch(err) {}
    }

    document.addEventListener('message', handleMessage);
    window.addEventListener('message', handleMessage);
    init();
  </script>
</body>
</html>`;

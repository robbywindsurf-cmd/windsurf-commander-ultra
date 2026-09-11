// movenetWebView.js
// MoveNet inference WebView with:
// 1. Equirectangular → perspective re-projection
// 2. Auto-tracking constrained to ±30° horizontal, ±20° vertical of initial tap
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
    var WINDOW_THETA     = 30;
    var WINDOW_PHI       = 20;

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

    // ── Update tracking angles ────────────────────────────────────────────
    function updateTrackingAngles(centroid, currentTheta, currentPhi, anchorTheta, anchorPhi) {
      if (!centroid) return { nextTheta: currentTheta, nextPhi: currentPhi };

      var offsetX  = centroid.cx - OUT_WIDTH  / 2;
      var offsetY  = centroid.cy - OUT_HEIGHT / 2;
      var degPerPx = FOV / OUT_WIDTH;

      var newTheta = currentTheta + offsetX * degPerPx * (1 - TRACKING_SMOOTH);
      var newPhi   = currentPhi   - offsetY * degPerPx * (1 - TRACKING_SMOOTH);

      // Constrain to search window around initial tap
      if (anchorTheta !== null && anchorTheta !== undefined) {
        newTheta = Math.max(anchorTheta - WINDOW_THETA, Math.min(anchorTheta + WINDOW_THETA, newTheta));
      }
      if (anchorPhi !== null && anchorPhi !== undefined) {
        newPhi = Math.max(anchorPhi - WINDOW_PHI, Math.min(anchorPhi + WINDOW_PHI, newPhi));
      }

      newPhi = Math.max(-85, Math.min(85, newPhi));
      return { nextTheta: newTheta, nextPhi: newPhi };
    }

    // ── Equirectangular → perspective ─────────────────────────────────────
    function equirectangularToPerspective(srcCanvas, theta, phi) {
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

      var fovRad   = FOV   * Math.PI / 180;
      var thetaRad = theta * Math.PI / 180;
      var phiRad   = phi   * Math.PI / 180;
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
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'result', frameId: frameId,
            keypoints: null, annotatedFrame: null,
            nextTheta: currentTheta, nextPhi: currentPhi
          }));
          return;
        }

        var keypoints = poses[0].keypoints.map(function(kp) {
          return [kp.x, kp.y, kp.score || 0];
        });

        var centroid   = getRiderCentroid(keypoints, 0.25);
        var nextAngles = updateTrackingAngles(centroid, currentTheta, currentPhi, anchorTheta, anchorPhi);

        var infCtx = inferenceCanvas.getContext('2d');
        drawSkeleton(infCtx, keypoints, 0.25);
        var annotatedFrame = inferenceCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];

        window.ReactNativeWebView.postMessage(JSON.stringify({
          type:           'result',
          frameId:        frameId,
          keypoints:      keypoints,
          annotatedFrame: annotatedFrame,
          nextTheta:      nextAngles.nextTheta,
          nextPhi:        nextAngles.nextPhi,
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

// ClipSelectorScreen.js
// Landscape video scrubber with rider tap, auto-tracking, skeleton overlay, frame review.
// Ported from production app — only the post-analysis navigation target changed
// (Chat webhook screen doesn't exist here; goes to local SessionDetail instead).

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TouchableWithoutFeedback, Image,
} from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as ScreenOrientation from 'expo-screen-orientation';
import { TierService, canAccess, AnalysisRepository, TrackpointRepository, WeightRepository, ForceCalculator, describeFrontLeg, describeBackLeg, describeForwardLean } from '@commandersuite/core';
import { analyseSessionVideo } from '../utils/poseAnalysisPipeline';
import { videoUtcPlusSeconds } from '../utils/videoUtc';
import { colors } from '../theme';

// Matches the pipeline's frame-extraction width — see poseAnalysisPipeline.js.
const FRAME_WIDTH = 960;

async function unlockToPortrait() {
  try {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  } catch (err) {
    console.warn('[ClipSelector] orientation unlock failed:', err.message);
  }
}

const DEEP   = colors.deep;
const SKY    = colors.accent;
const ACCENT = colors.amber;
const TEXT   = colors.text;
const DANGER = colors.danger;
const GREEN  = colors.green;

function pixelToAngles(cx, cy, frameW, frameH) {
  return {
    theta: (cx / frameW) * 360 - 180,
    phi:   90 - (cy / frameH) * 180,
  };
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
}

export default function ClipSelectorScreen({ route, navigation }) {
  const { videoUri, sessionId, sessionName, videoStartUtc, fname } = route.params;

  const cancelRef = useRef(false);
  const unlockedRef = useRef(false);
  const player = useVideoPlayer(videoUri, (p) => {
    p.timeUpdateEventInterval = 0.25;
  });

  const [duration, setDuration]       = useState(0);
  const [position, setPosition]       = useState(0);
  const [startMs, setStartMs]         = useState(null);
  const [isPlaying, setIsPlaying]     = useState(false);
  const [scrubberWidth, setScrubberWidth] = useState(1);
  const [videoLayout, setVideoLayout] = useState(null);

  const [mode, setMode]               = useState('scrub');
  const [riderAngles, setRiderAngles] = useState(null);
  const [riderTapPos, setRiderTapPos] = useState(null);

  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  const [analysisStatus, setAnalysisStatus]     = useState('');
  const [analysisError, setAnalysisError]       = useState(null);
  const [currentFrame, setCurrentFrame]         = useState(null);

  const [annotatedFrames, setAnnotatedFrames] = useState([]); // { image, timeS, leftKneeAngle, rightKneeAngle, backAngle, hipX }[]
  const [reviewIndex, setReviewIndex]         = useState(0);
  const [userTier, setUserTier]               = useState('free');
  const [summary, setSummary]                 = useState(null);
  const [frameGps, setFrameGps]               = useState(null); // { speed_kn, hr } | null for the current reviewIndex
  const [gpsCoverage, setGpsCoverage]         = useState(undefined); // { count, first_ts, last_ts } | undefined while loading
  const [riderWeightKg, setRiderWeightKg]     = useState(null); // most recent weight_log entry, or null (ForceCalculator defaults to 75kg)

  useEffect(() => {
    WeightRepository.getAll()
      .then((entries) => setRiderWeightKg(entries.length ? entries[entries.length - 1].weight_kg : null))
      .catch(() => setRiderWeightKg(null));
  }, []);

  useEffect(() => {
    TierService.getCachedTier().then(setUserTier);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    TrackpointRepository.getCoverageForSession(sessionId)
      .then(setGpsCoverage)
      .catch(() => setGpsCoverage(null));
  }, [sessionId]);

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    // Belt-and-braces: this screen's own buttons already await the unlock
    // before navigating, but beforeRemove catches every other way off this
    // screen too (hardware back, swipe-back if ever re-enabled). Blocking
    // the removal until the unlock resolves — rather than firing it and
    // letting the transition proceed in parallel — is what actually fixes
    // the race: the destination screen was animating in mid-rotation before,
    // leaving the view split between the old landscape frame and the new
    // portrait content.
    const unsub = navigation.addListener('beforeRemove', (e) => {
      // Already unlocked (either by this handler's own redispatch below, or
      // by a button's own await-then-navigate) — let this removal through
      // as normal, or dispatching the redispatch below would loop forever.
      if (unlockedRef.current) return;
      e.preventDefault();
      unlockToPortrait().finally(() => {
        unlockedRef.current = true;
        navigation.dispatch(e.data.action);
      });
    });
    return () => {
      unsub();
      unlockToPortrait();
    };
  }, [navigation]);

  useEffect(() => {
    const timeSub = player.addListener('timeUpdate', ({ currentTime }) => {
      setPosition(Math.round(currentTime * 1000));
      if (player.duration) setDuration(Math.round(player.duration * 1000));
    });
    const playingSub = player.addListener('playingChange', ({ isPlaying: playing }) => {
      setIsPlaying(playing);
    });
    return () => { timeSub.remove(); playingSub.remove(); };
  }, [player]);

  function seekTo(ms) {
    player.currentTime = ms / 1000;
    setPosition(ms);
  }

  function onSetStart() {
    player.pause();
    setStartMs(position);
    setMode('locateRider');
  }

  function onVideoTap(e) {
    if (mode !== 'locateRider') return;
    if (!videoLayout) return;
    const { locationX, locationY } = e.nativeEvent;
    const angles = pixelToAngles(locationX, locationY, videoLayout.width, videoLayout.height);
    setRiderAngles(angles);
    setRiderTapPos({ x: locationX, y: locationY });
    setMode('ready');
  }

  function cancelAnalysis() {
    cancelRef.current = true;
    setMode('ready');
    setAnalysisStatus('');
    setCurrentFrame(null);
  }

  async function runAnalysis() {
    if (!sessionId) { setAnalysisError('No session assigned.'); return; }
    cancelRef.current = false;
    setMode('analysing');
    setAnalysisError(null);
    setCurrentFrame(null);
    setAnnotatedFrames([]);
    setAnalysisStatus('Preparing…');

    // Skeleton overlay + frame review are premium/ultimate perks (FULL_ANALYSIS).
    // Free tier still gets the full MoveNet pass and its angle averages —
    // just no live preview and no frames kept around afterwards.
    const canSeeSkeleton = canAccess('FULL_ANALYSIS', userTier);

    try {
      const result = await analyseSessionVideo({
        videoUri,
        sessionId,
        board:    null,
        notes:    'Analysed from ' + fname + ' at ' + formatTime(startMs || 0),
        userTier,
        onProgress: (current, total) => {
          if (cancelRef.current) return;
          setAnalysisProgress({ current, total });
        },
        onFrame: (annotatedFrame, timeS, frameMeasurements) => {
          if (cancelRef.current || !canSeeSkeleton) return;
          if (annotatedFrame) {
            setCurrentFrame(annotatedFrame);
            setAnnotatedFrames(prev => [...prev, {
              image: annotatedFrame,
              timeS,
              leftKneeAngle: frameMeasurements?.leftKneeAngle ?? null,
              rightKneeAngle: frameMeasurements?.rightKneeAngle ?? null,
              backAngle: frameMeasurements?.backAngle ?? null,
              hipX: frameMeasurements?.hipX ?? null,
            }]);
          }
        },
        onStatus: (msg) => {
          if (cancelRef.current) return;
          setAnalysisStatus(msg);
        },
        videoStartUtc,
        fname,
        startMs:    startMs || 0,
        riderTheta: riderAngles?.theta,
        riderPhi:   riderAngles?.phi,
      });

      if (!cancelRef.current) {
        setSummary(result);
        setMode(canSeeSkeleton ? 'review' : 'summary');
        setReviewIndex(0);
        setAnalysisStatus('');
      }
    } catch (err) {
      if (!cancelRef.current) {
        setAnalysisError(err.message || 'Analysis failed.');
        setMode('ready');
        setAnalysisStatus('');
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    const frame = annotatedFrames[reviewIndex];
    const frameUtc = frame ? videoUtcPlusSeconds(videoStartUtc, frame.timeS) : null;
    if (!frameUtc) {
      setFrameGps(null);
      return;
    }
    AnalysisRepository.correlateFrameToGPS(sessionId, frameUtc)
      .then((row) => { if (!cancelled) setFrameGps(row || null); })
      .catch(() => { if (!cancelled) setFrameGps(null); });
    return () => { cancelled = true; };
  }, [reviewIndex, annotatedFrames, sessionId, videoStartUtc]);

  async function goToSessionDetail() {
    await unlockToPortrait();
    navigation.navigate('SessionDetail', { sessionId });
  }

  async function goToUpgrade() {
    await unlockToPortrait();
    navigation.navigate('Upgrade', { featureId: 'FULL_ANALYSIS' });
  }

  async function exitClipSelector() {
    await unlockToPortrait();
    navigation.goBack();
  }

  const analysing   = mode === 'analysing';
  const progressPct = duration > 0 ? position / duration : 0;
  const startPct    = duration > 0 && startMs !== null ? startMs / duration : null;

  // Only meaningful when this frame actually has detected keypoints (both
  // knee angles present) — a frame where pose detection failed has nothing
  // to estimate from.
  const reviewFrame = annotatedFrames[reviewIndex];
  const hasPose = reviewFrame && reviewFrame.leftKneeAngle != null && reviewFrame.rightKneeAngle != null;
  const forceEstimate = hasPose
    ? ForceCalculator.calculate({
        leftKneeAngle: reviewFrame.leftKneeAngle,
        rightKneeAngle: reviewFrame.rightKneeAngle,
        hipX: reviewFrame.hipX,
        frameWidth: FRAME_WIDTH,
        riderWeightKg,
        speedKn: frameGps?.speed_kn ?? 0,
      })
    : null;
  const frontLegDesc = hasPose ? describeFrontLeg(reviewFrame.leftKneeAngle) : null;
  const backLegDesc = hasPose ? describeBackLeg(reviewFrame.rightKneeAngle) : null;
  const forwardLeanDesc = hasPose && reviewFrame.backAngle != null ? describeForwardLean(reviewFrame.backAngle) : null;

  // Explains *why* speed/HR are missing instead of a bare "—" — a video
  // frame's timestamp landing outside the FIT file's actual GPS coverage
  // (e.g. the watch was stopped before the camera was) looks identical to
  // "no FIT file imported at all" unless this is spelled out.
  const gpsUnavailableReason = (() => {
    if (frameGps) return null;
    if (gpsCoverage === undefined) return 'Checking…';
    if (!gpsCoverage || !gpsCoverage.count) return 'No FIT file imported for this session';
    const frameUtc = reviewFrame ? videoUtcPlusSeconds(videoStartUtc, reviewFrame.timeS) : null;
    if (frameUtc && gpsCoverage.first_ts && gpsCoverage.last_ts &&
        (frameUtc < gpsCoverage.first_ts || frameUtc > gpsCoverage.last_ts)) {
      return 'Outside FIT GPS time range for this session';
    }
    return 'No GPS point within 3s of this frame';
  })();

  return (
    <View style={styles.container}>

      {mode === 'review' ? (
        <View style={styles.reviewArea}>
          <View style={styles.reviewVideoColumn}>
            {annotatedFrames[reviewIndex] ? (
              <Image
                source={{ uri: 'data:image/jpeg;base64,' + annotatedFrames[reviewIndex].image }}
                style={{ flex: 1 }}
                resizeMode="contain"
              />
            ) : (
              <View style={{ flex:1, alignItems:'center', justifyContent:'center' }}>
                <Text style={{ color: TEXT }}>No frame</Text>
              </View>
            )}

            <View style={styles.reviewControls}>
              <Text style={styles.reviewCounter}>
                Frame {reviewIndex + 1} / {annotatedFrames.length}
                {frameGps ? `  ·  ${frameGps.speed_kn?.toFixed(1) ?? '—'} kn${frameGps.hr ? `  ·  ${frameGps.hr} bpm` : ''}` : ''}
              </Text>
              <View style={styles.reviewBtnRow}>
                <TouchableOpacity activeOpacity={0.7}
                  style={styles.reviewBtn}
                  onPress={() => setReviewIndex(Math.max(0, reviewIndex - 1))}
                >
                  <Text style={styles.reviewBtnText}>◀ Prev</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7}
                  style={styles.reviewBtn}
                  onPress={() => setReviewIndex(Math.min(annotatedFrames.length - 1, reviewIndex + 1))}
                >
                  <Text style={styles.reviewBtnText}>Next ▶</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7}
                  style={[styles.reviewBtn, { backgroundColor: SKY }]}
                  onPress={goToSessionDetail}
                >
                  <Text style={styles.reviewBtnText}>📋 Session</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7}
                  style={[styles.reviewBtn, { backgroundColor: DANGER }]}
                  onPress={() => { setMode('ready'); setAnnotatedFrames([]); setCurrentFrame(null); }}
                >
                  <Text style={styles.reviewBtnText}>✕ Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {annotatedFrames.length > 0 && (
            // Always mounted at the same fixed width regardless of whether
            // this specific frame has pose data — the panel previously
            // vanished entirely on frames with no detected pose (hasPose
            // false), which let the video column beside it expand to fill
            // the freed width, visibly resizing the video between frames.
            <ScrollView style={styles.analysisSidePanel} contentContainerStyle={styles.analysisRowContent}>
              {hasPose ? (
                <>
                  <View style={styles.analysisCard}>
                    <Text style={styles.analysisCardTitle}>FOOT PRESSURE (estimated)</Text>
                    <View style={styles.pressureBarRow}>
                      <Text style={styles.pressureLabel}>Front</Text>
                      <View style={styles.pressureBarTrack}>
                        <View style={[styles.pressureBarFill, { width: `${forceEstimate.frontFootPct}%`, backgroundColor: SKY }]} />
                      </View>
                      <Text style={styles.pressureValue}>{forceEstimate.frontFootPct}%  {forceEstimate.frontFootKg}kg</Text>
                    </View>
                    <View style={styles.pressureBarRow}>
                      <Text style={styles.pressureLabel}>Back</Text>
                      <View style={styles.pressureBarTrack}>
                        <View style={[styles.pressureBarFill, { width: `${forceEstimate.backFootPct}%`, backgroundColor: ACCENT }]} />
                      </View>
                      <Text style={styles.pressureValue}>{forceEstimate.backFootPct}%  {forceEstimate.backFootKg}kg</Text>
                    </View>
                    <Text style={styles.analysisLine}>Est. fin load: ~{forceEstimate.estimatedFinLoadKg}kg</Text>
                    <Text style={styles.analysisLine}>Speed factor: {forceEstimate.speedFactor}×</Text>
                    <Text style={styles.disclaimerText}>⚠️ {forceEstimate.disclaimer}</Text>
                  </View>

                  <View style={styles.analysisCard}>
                    <Text style={styles.analysisCardTitle}>BODY POSITION</Text>
                    <Text style={styles.analysisLine}>Front leg: {frontLegDesc ?? '—'}</Text>
                    <Text style={styles.analysisLine}>Back leg: {backLegDesc ?? '—'}</Text>
                    <Text style={styles.analysisLine}>Lean stance: {forwardLeanDesc ?? '—'}</Text>
                    <Text style={styles.analysisLine}>
                      Speed: {frameGps?.speed_kn != null ? `${frameGps.speed_kn.toFixed(1)}kn (at this frame)` : `— (${gpsUnavailableReason})`}
                    </Text>
                    <Text style={styles.analysisLine}>
                      HR: {frameGps?.hr != null ? `${frameGps.hr}bpm (at this frame)` : `— (${gpsUnavailableReason})`}
                    </Text>
                  </View>
                </>
              ) : (
                <View style={styles.analysisCard}>
                  <Text style={styles.analysisCardTitle}>NO POSE DATA</Text>
                  <Text style={styles.analysisLine}>Rider not clearly detected in this frame.</Text>
                </View>
              )}
            </ScrollView>
          )}
        </View>
      ) : mode === 'summary' ? (
        <View style={styles.summaryArea}>
          <Text style={styles.summaryTitle}>✅ Analysis Complete</Text>
          <View style={styles.summaryStats}>
            <Text style={styles.summaryRow}>Frames detected: {summary?.framesDetected ?? 0}/{summary?.framesTotal ?? 0}</Text>
            <Text style={styles.summaryRow}>Left knee avg: {summary?.left_knee_avg ?? '—'}°</Text>
            <Text style={styles.summaryRow}>Right knee avg: {summary?.right_knee_avg ?? '—'}°</Text>
            <Text style={styles.summaryRow}>Back angle avg: {summary?.back_angle_avg ?? '—'}°</Text>
          </View>
          <View style={styles.upgradeBanner}>
            <Text style={styles.upgradeBannerText}>
              🔒 Upgrade to Premium to see skeleton overlay, frame review and full coaching report
            </Text>
            <TouchableOpacity activeOpacity={0.7} style={styles.upgradeBannerBtn} onPress={goToUpgrade}>
              <Text style={styles.upgradeBannerBtnText}>Upgrade</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.reviewBtnRow}>
            <TouchableOpacity activeOpacity={0.7} style={[styles.reviewBtn, { backgroundColor: SKY }]} onPress={goToSessionDetail}>
              <Text style={styles.reviewBtnText}>📋 Session</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.reviewBtn, { backgroundColor: DANGER }]}
              onPress={() => { setMode('ready'); setSummary(null); }}
            >
              <Text style={styles.reviewBtnText}>✕ Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableWithoutFeedback onPress={onVideoTap}>
          <View
            style={styles.videoArea}
            onLayout={e => setVideoLayout({
              width:  e.nativeEvent.layout.width,
              height: e.nativeEvent.layout.height,
            })}
          >
            {analysing && currentFrame ? (
              <Image
                source={{ uri: 'data:image/jpeg;base64,' + currentFrame }}
                style={styles.video}
                resizeMode="contain"
              />
            ) : (
              <VideoView
                player={player}
                style={styles.video}
                contentFit="contain"
                nativeControls={false}
              />
            )}

            {analysing && !currentFrame && (
              <View pointerEvents="none" style={styles.statusOverlay}>
                <Text style={styles.statusText}>{analysisStatus || 'Starting…'}</Text>
              </View>
            )}

            {riderTapPos && !analysing && (
              <View
                pointerEvents="none"
                style={[styles.crosshair, { left: riderTapPos.x - 20, top: riderTapPos.y - 20 }]}
              >
                <View style={styles.crosshairH} />
                <View style={styles.crosshairV} />
                <View style={styles.crosshairCircle} />
              </View>
            )}

            {mode === 'locateRider' && (
              <View pointerEvents="none" style={styles.locateOverlay}>
                <Text style={styles.locateText}>👆 Tap on yourself in the video</Text>
              </View>
            )}
          </View>
        </TouchableWithoutFeedback>
      )}

      {mode !== 'review' && mode !== 'summary' && (
        <View style={styles.controls}>

          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{formatTime(position)}</Text>
            <Text style={styles.timeSep}>/</Text>
            <Text style={styles.timeDim}>{formatTime(duration)}</Text>
            {startMs !== null && (
              <Text style={styles.startBadge}>▶ {formatTime(startMs)}</Text>
            )}
            {riderAngles && (
              <Text style={styles.anglesBadge}>
                θ{riderAngles.theta.toFixed(0)}° φ{riderAngles.phi.toFixed(0)}°
              </Text>
            )}
          </View>

          {!analysing && (
            <TouchableOpacity
              style={styles.scrubberTrack}
              onLayout={e => setScrubberWidth(e.nativeEvent.layout.width)}
              onPress={e => {
                if (mode === 'locateRider') return;
                const pct = Math.max(0, Math.min(1, e.nativeEvent.locationX / scrubberWidth));
                seekTo(Math.round(pct * duration));
              }}
              activeOpacity={1}
            >
              <View style={[styles.scrubberPlayed, { width: (progressPct * 100) + '%' }]} />
              {startPct !== null && (
                <View style={[styles.startMarker, { left: (startPct * 100) + '%' }]} />
              )}
              <View style={[styles.scrubberThumb, { left: (progressPct * 100) + '%' }]} />
            </TouchableOpacity>
          )}

          <View style={styles.btnRow}>

            {!analysing && mode !== 'locateRider' && (
              <>
                <TouchableOpacity activeOpacity={0.7}
                  style={styles.playBtn}
                  onPress={() => {
                    if (isPlaying) player.pause();
                    else player.play();
                  }}
                >
                  <Text style={styles.playBtnText}>{isPlaying ? '⏸' : '▶'}</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7} style={styles.skipBtn} onPress={() => seekTo(Math.max(0, position - 10000))}>
                  <Text style={styles.skipBtnText}>-10s</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7} style={styles.skipBtn} onPress={() => seekTo(Math.min(duration, position + 10000))}>
                  <Text style={styles.skipBtnText}>+10s</Text>
                </TouchableOpacity>
              </>
            )}

            {mode === 'scrub' && (
              <TouchableOpacity activeOpacity={0.7} style={styles.setStartBtn} onPress={onSetStart}>
                <Text style={styles.setStartBtnText}>📍 Set Start</Text>
              </TouchableOpacity>
            )}

            {mode === 'ready' && (
              <>
                <TouchableOpacity activeOpacity={0.7}
                  style={styles.retapBtn}
                  onPress={() => { setMode('locateRider'); setRiderTapPos(null); setRiderAngles(null); }}
                >
                  <Text style={styles.retapBtnText}>👆 Re-tap</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7} style={styles.analyseBtn} onPress={runAnalysis}>
                  <Text style={styles.analyseBtnText}>🏄 Analyse</Text>
                </TouchableOpacity>
              </>
            )}

            {analysing && (
              <>
                <View style={styles.analysingBox}>
                  <Text style={styles.analysingText}>
                    {analysisProgress.total > 0
                      ? 'Frame ' + analysisProgress.current + '/' + analysisProgress.total
                      : analysisStatus || 'Starting…'}
                  </Text>
                </View>
                <TouchableOpacity activeOpacity={0.7} style={styles.cancelBtn} onPress={cancelAnalysis}>
                  <Text style={styles.cancelBtnText}>⏹ Cancel</Text>
                </TouchableOpacity>
              </>
            )}

            {!analysing && (
              <TouchableOpacity activeOpacity={0.7} style={styles.exitBtn} onPress={exitClipSelector}>
                <Text style={styles.cancelBtnText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          {mode === 'scrub' && !startMs && (
            <Text style={styles.hintText}>Scrub to sailing section, tap 📍 Set Start</Text>
          )}
          {mode === 'locateRider' && (
            <Text style={styles.hintText}>Tap on yourself in the video</Text>
          )}
          {mode === 'ready' && (
            <Text style={styles.hintText}>✅ Rider located — tap 🏄 Analyse</Text>
          )}
          {!!analysisError && (
            <Text style={styles.errorText}>⚠️ {analysisError}</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#000', flexDirection: 'row' },
  videoArea:  { flex: 1, backgroundColor: '#000' },
  video:      { flex: 1 },

  statusOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(6,31,46,0.7)',
    alignItems: 'center', justifyContent: 'center',
  },
  statusText: { color: TEXT, fontSize: 18, fontWeight: '600' },

  // Side-by-side in landscape: video (+ its controls) on the left, analysis
  // cards in a fixed-width scrollable column on the right — previously the
  // analysis cards were a full-width overlay up to 55% of screen height on
  // top of the video, which on a landscape screen left only thin slivers
  // of the actual frame visible above and below the overlay.
  reviewArea: { flex: 1, flexDirection: 'row', backgroundColor: '#000' },
  reviewVideoColumn: { flex: 1 },

  summaryArea: { flex: 1, backgroundColor: DEEP, padding: 24, justifyContent: 'center' },
  summaryTitle: { color: TEXT, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  summaryStats: {
    backgroundColor: 'rgba(26,138,181,0.08)', borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: 'rgba(26,138,181,0.2)', marginBottom: 16,
  },
  summaryRow: { color: TEXT, fontSize: 14, marginBottom: 6 },
  upgradeBanner: {
    backgroundColor: 'rgba(240,165,0,0.12)', borderWidth: 1, borderColor: 'rgba(240,165,0,0.3)',
    borderRadius: 12, padding: 14, marginBottom: 16, alignItems: 'center',
  },
  upgradeBannerText: { color: ACCENT, fontSize: 13, textAlign: 'center', marginBottom: 10 },
  upgradeBannerBtn: { backgroundColor: ACCENT, paddingVertical: 8, paddingHorizontal: 20, borderRadius: 8 },
  upgradeBannerBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  analysisSidePanel: {
    width: 260, backgroundColor: 'rgba(6,31,46,0.5)',
    borderLeftWidth: 1, borderLeftColor: 'rgba(255,255,255,0.08)',
  },
  analysisRowContent: { padding: 8, gap: 8 },
  analysisCard: {
    backgroundColor: 'rgba(6,31,46,0.92)', borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  analysisCardTitle: { color: TEXT, fontSize: 12, fontWeight: '700', marginBottom: 8, letterSpacing: 0.5 },
  analysisLine: { color: TEXT, fontSize: 12, marginBottom: 4 },
  disclaimerText: { color: ACCENT, fontSize: 11, marginTop: 6 },
  pressureBarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 8 },
  pressureLabel: { color: TEXT, fontSize: 11, width: 40 },
  pressureBarTrack: {
    flex: 1, height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden',
  },
  pressureBarFill: { height: '100%', borderRadius: 5 },
  pressureValue: { color: TEXT, fontSize: 11, width: 90, textAlign: 'right' },
  reviewControls: {
    backgroundColor: 'rgba(6,31,46,0.9)', paddingVertical: 8, paddingHorizontal: 6,
  },
  reviewCounter: { color: TEXT, fontSize: 12, textAlign: 'center', marginBottom: 6 },
  reviewBtnRow:  { flexDirection: 'row', gap: 6, justifyContent: 'center' },
  reviewBtn: {
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: 'rgba(26,138,181,0.3)', borderRadius: 8,
  },
  reviewBtnText: { color: TEXT, fontSize: 12, fontWeight: '600' },

  crosshair: { position: 'absolute', width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  crosshairH: { position: 'absolute', width: 40, height: 2, backgroundColor: ACCENT },
  crosshairV: { position: 'absolute', width: 2, height: 40, backgroundColor: ACCENT },
  crosshairCircle: {
    position: 'absolute', width: 14, height: 14,
    borderRadius: 7, borderWidth: 2, borderColor: ACCENT,
  },

  locateOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0,
    backgroundColor: 'rgba(240,165,0,0.85)',
    paddingVertical: 8, alignItems: 'center',
  },
  locateText: { color: '#000', fontSize: 14, fontWeight: '700' },

  controls: {
    width: 220, backgroundColor: DEEP,
    paddingHorizontal: 12, paddingVertical: 10,
    justifyContent: 'center',
    borderLeftWidth: 1, borderLeftColor: 'rgba(26,138,181,0.25)',
  },

  timeRow:   { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, gap: 4 },
  timeText:  { color: TEXT, fontSize: 12, fontWeight: '600' },
  timeSep:   { color: 'rgba(205,232,240,0.4)', fontSize: 12, marginHorizontal: 2 },
  timeDim:   { color: 'rgba(205,232,240,0.4)', fontSize: 12 },
  startBadge: {
    color: ACCENT, fontSize: 11, fontWeight: '600',
    backgroundColor: 'rgba(240,165,0,0.15)',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  anglesBadge: {
    color: SKY, fontSize: 10,
    backgroundColor: 'rgba(26,138,181,0.15)',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },

  scrubberTrack: {
    height: 6, backgroundColor: 'rgba(26,138,181,0.2)',
    borderRadius: 3, marginBottom: 10, position: 'relative',
  },
  scrubberPlayed: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: SKY, borderRadius: 3 },
  startMarker:    { position: 'absolute', top: -8, width: 3, height: 22, backgroundColor: ACCENT, marginLeft: -1.5 },
  scrubberThumb:  { position: 'absolute', top: -5, width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff', marginLeft: -8 },

  btnRow: { flexDirection: 'column', gap: 8 },

  playBtn:     { height: 36, borderRadius: 8, backgroundColor: SKY, alignItems: 'center', justifyContent: 'center' },
  playBtnText: { fontSize: 16, color: '#fff' },
  skipBtn:     { height: 32, borderRadius: 8, backgroundColor: 'rgba(26,138,181,0.2)', alignItems: 'center', justifyContent: 'center' },
  skipBtnText: { color: TEXT, fontSize: 11, fontWeight: '600' },

  setStartBtn:     { height: 36, borderRadius: 8, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  setStartBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  retapBtn:     { height: 36, borderRadius: 8, backgroundColor: 'rgba(240,165,0,0.2)', borderWidth: 1, borderColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  retapBtnText: { color: ACCENT, fontSize: 12, fontWeight: '600' },

  analyseBtn:     { height: 40, borderRadius: 8, backgroundColor: GREEN, alignItems: 'center', justifyContent: 'center' },
  analyseBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  analysingBox:   { borderRadius: 8, backgroundColor: 'rgba(26,138,181,0.2)', padding: 8, alignItems: 'center' },
  analysingText:  { color: SKY, fontSize: 11, textAlign: 'center' },

  cancelBtn:     { height: 36, borderRadius: 8, backgroundColor: 'rgba(230,57,70,0.3)', alignItems: 'center', justifyContent: 'center' },
  exitBtn:       { height: 36, borderRadius: 8, backgroundColor: 'rgba(230,57,70,0.2)', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  cancelBtnText: { color: DANGER, fontSize: 13, fontWeight: '700' },

  hintText:  { color: 'rgba(205,232,240,0.4)', fontSize: 10, marginTop: 8, textAlign: 'center' },
  errorText: { color: DANGER, fontSize: 11, marginTop: 6 },
});

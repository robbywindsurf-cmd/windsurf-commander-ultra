import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Modal, FlatList, ActivityIndicator, NativeModules,
} from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import { SessionRepository, FeatureGate } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { analyseSessionVideo } from '../utils/poseAnalysisPipeline';
import { registerWebView, handleWebViewMessage, disposeDetector } from '../utils/moveNet';
import { MOVENET_HTML } from '../utils/movenetWebView.js';
import { GPMF_HTML } from '../utils/gpmfWebView.js';
import { registerGPMFWebView, handleGPMFMessage, extractVideoStartTime, disposeGPMF } from '../utils/gpmfExtractor.js';
import { colors } from '../theme';

const DEEP = colors.deep;
const SKY = colors.accent;
const ACCENT = colors.amber;
const TEXT = colors.text;
const DANGER = colors.danger;

const IMPORTED_VIDEOS_KEY = 'windsurf_imported_videos';
const VIDEOS_DIR = FileSystem.documentDirectory + 'imported_videos/';

function isVideo360(fname) {
  return (fname || '').toLowerCase().endsWith('.360');
}

async function ensureVideosDir() {
  const info = await FileSystem.getInfoAsync(VIDEOS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(VIDEOS_DIR, { intermediates: true });
  }
}

function autoMatchSession(videoStartUtc, allSessions) {
  if (!videoStartUtc || !allSessions.length) return null;
  const videoDate = `${videoStartUtc.slice(0,4)}-${videoStartUtc.slice(4,6)}-${videoStartUtc.slice(6,8)}`;
  const videoSecs = parseInt(videoStartUtc.slice(9,11))*3600
                  + parseInt(videoStartUtc.slice(11,13))*60
                  + parseInt(videoStartUtc.slice(13,15));
  const same = allSessions.filter(s => s.date === videoDate);
  if (!same.length) return null;
  if (same.length === 1) return same[0];
  let best = null, bestDiff = Infinity;
  for (const s of same) {
    if (s.start_time) {
      const [sh, sm] = s.start_time.split(':').map(Number);
      const diff = Math.abs(videoSecs - (sh*3600 + sm*60));
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
  }
  return bestDiff < 10800 ? best : null;
}

export default function VideoScreen({ navigation }) {
  const [activeVideo, setActiveVideo]   = useState(null);
  const [playerError, setPlayerError]   = useState(null);
  const webviewRef       = useRef(null);
  const movenetWebViewRef = useRef(null);
  const gpmfWebViewRef   = useRef(null);

  const [importedVideos, setImportedVideos] = useState([]);
  const [pendingImport, setPendingImport]   = useState(null);
  const [pickerError, setPickerError]       = useState(null);
  const [allSessions, setAllSessions]       = useState([]);
  const [importingFile, setImportingFile]   = useState(null);

  const [analysing, setAnalysing]               = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  const [analysisResult, setAnalysisResult]     = useState(null);
  const [analysisError, setAnalysisError]       = useState(null);

  const player = useVideoPlayer(activeVideo?.url ?? null, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    if (!player) return;
    const sub = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'error') setPlayerError(error?.message || 'Could not load video.');
    });
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    registerWebView(movenetWebViewRef);
    registerGPMFWebView(gpmfWebViewRef);
    console.log('[GoProMedia] module available:', !!NativeModules.GoProMediaModule);
    return () => { disposeDetector(); disposeGPMF(); };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(IMPORTED_VIDEOS_KEY);
        if (!stored) return;
        const videos = JSON.parse(stored);
        const verified = [];
        for (const v of videos) {
          try {
            const info = await FileSystem.getInfoAsync(v.uri);
            if (info.exists) verified.push(v);
          } catch (_) {}
        }
        setImportedVideos(verified);
        if (verified.length !== videos.length)
          await AsyncStorage.setItem(IMPORTED_VIDEOS_KEY, JSON.stringify(verified));
      } catch (err) {
        console.warn('[VideoScreen] load error:', err.message);
      }
    })();
  }, []);

  // Sessions come from the local SQLite DB (no Oracle) — free tier local-first.
  useEffect(() => {
    (async () => {
      try {
        const rows = await SessionRepository.getAll();
        const sessions = rows.map((s) => ({
          date: s.date,
          name: s.date,
          session_id: s.session_id,
          start_time: s.start_time,
        }));
        setAllSessions(sessions);
      } catch (err) {
        console.warn('[VideoScreen] sessions load error:', err.message);
      }
    })();
  }, []);

  async function saveVideos(videos) {
    try { await AsyncStorage.setItem(IMPORTED_VIDEOS_KEY, JSON.stringify(videos)); }
    catch (err) { console.warn('[VideoScreen] save error:', err.message); }
  }

  function playVideo(item) {
    setPlayerError(null);
    setActiveVideo({
      url: item.uri,
      sessionName: item.sessionName,
      fname: item.fname,
      is360: false,
      session_id: item.session_id,
      video_start_utc: item.video_start_utc || null,
    });
    resetAnalysisState();
  }

  useEffect(() => {
    if (activeVideo && player) player.play();
  }, [activeVideo, player]);

  function closeVideo() {
    setActiveVideo(null);
    setPlayerError(null);
    resetAnalysisState();
  }

  function resetAnalysisState() {
    setAnalysing(false);
    setAnalysisProgress({ current: 0, total: 0 });
    setAnalysisResult(null);
    setAnalysisError(null);
  }

  async function pickVideoFromPhone() {
    setPickerError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: false,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      let fname = asset.name || asset.uri.split('/').pop() || 'imported-video.mp4';
      let uri   = asset.uri;
      const is360 = isVideo360(fname);

      setImportingFile({ fname, progress: 0.05, status: '📍 Extracting GPS data…' });
      await new Promise(r => setTimeout(r, 80));

      const gpmfResult = await extractVideoStartTime(uri);
      const videoStartUtc = gpmfResult?.videoStartUtc || null;

      await ensureVideosDir();

      if (is360) {
        const { GoProMediaModule } = NativeModules;
        if (GoProMediaModule) {
          setImportingFile({ fname, progress: 0.2, status: '🔄 Converting 360° to flat MP4…\nThis may take several minutes' });
          await new Promise(r => setTimeout(r, 80));

          const baseName = fname.replace(/\.360$/i, '');
          const outputPath = VIDEOS_DIR.replace('file://', '') + baseName + '_erp.mp4';
          const inputPath  = uri.replace('file://', '');

          try {
            const mp4Path = await GoProMediaModule.exportERP(
              inputPath, outputPath, 3840, 1920, true, true
            );
            const info = await FileSystem.getInfoAsync('file://' + mp4Path);

            if (info.exists && info.size > 0) {
              uri   = 'file://' + mp4Path;
              fname = baseName + '_erp.mp4';
            } else {
              throw new Error('Output file is empty or missing');
            }
          } catch (erpErr) {
            console.warn('[ERP] conversion failed:', erpErr.message);
            setImportingFile({ fname, progress: 0, status: '❌ Conversion failed: ' + erpErr.message });
            await new Promise(r => setTimeout(r, 2000));
            setImportingFile(null);
            setPickerError('360° conversion failed: ' + erpErr.message);
            return;
          }
        } else {
          setPickerError('GoPro SDK not available — rebuild the app.');
          setImportingFile(null);
          return;
        }
      } else {
        setImportingFile({ fname, progress: 0.5, status: '📋 Copying video to app…' });
        await new Promise(r => setTimeout(r, 50));
        const ext     = fname.split('.').pop() || 'mp4';
        const destUri = VIDEOS_DIR + `${Date.now()}.${ext}`;
        await FileSystem.copyAsync({ from: uri, to: destUri });
        uri = destUri;
      }

      setImportingFile({ fname, progress: 0.95, status: '🔍 Matching session…' });
      await new Promise(r => setTimeout(r, 50));

      const matched = autoMatchSession(videoStartUtc, allSessions);

      setImportingFile({ fname, progress: 1.0, status: '✅ Complete!' });
      await new Promise(r => setTimeout(r, 700));
      setImportingFile(null);

      if (matched) {
        const newVideo = {
          uri, fname,
          session_id:     matched.session_id,
          sessionName:    matched.name,
          date:           matched.date,
          video_start_utc: videoStartUtc,
        };
        const updated = [...importedVideos, newVideo];
        setImportedVideos(updated);
        await saveVideos(updated);
      } else {
        setPendingImport({ uri, fname, videoStartUtc });
      }

    } catch (err) {
      console.warn('[VideoScreen] import error:', err.message);
      setPickerError('Could not import video: ' + err.message);
      setImportingFile(null);
    }
  }

  async function confirmSessionForImport(date, sessionId, sessionName) {
    if (!pendingImport) return;
    const newVideo = {
      uri:           pendingImport.uri,
      fname:         pendingImport.fname,
      session_id:    sessionId,
      sessionName,
      date,
      video_start_utc: pendingImport.videoStartUtc || null,
    };
    const updated = [...importedVideos, newVideo];
    setImportedVideos(updated);
    await saveVideos(updated);
    setPendingImport(null);
  }

  function cancelImport() { setPendingImport(null); }

  async function deleteVideo(index) {
    const video = importedVideos[index];
    try {
      if (video.uri.startsWith(VIDEOS_DIR)) {
        await FileSystem.deleteAsync(video.uri, { idempotent: true });
      }
    } catch (_) {}
    const updated = importedVideos.filter((_,i) => i !== index);
    setImportedVideos(updated);
    await saveVideos(updated);
    if (activeVideo?.url === video.uri) closeVideo();
  }

  async function analyseActiveVideo() {
    if (!activeVideo) return;
    setAnalysing(true);
    setAnalysisError(null);
    setAnalysisResult(null);
    setAnalysisProgress({ current: 0, total: 0 });
    try {
      if (!activeVideo.session_id) throw new Error('No session assigned to this video.');
      const result = await analyseSessionVideo({
        videoUri:      activeVideo.url,
        sessionId:     activeVideo.session_id,
        board:         null,
        notes:         `Analysed from ${activeVideo.fname}`,
        onProgress:    (current, total) => setAnalysisProgress({ current, total }),
        videoStartUtc: activeVideo.video_start_utc || null,
        fname:         activeVideo.fname,
      });
      setAnalysisResult(result);
    } catch (err) {
      setAnalysisError(err.message || 'Analysis failed.');
    } finally {
      setAnalysing(false);
    }
  }

  const videosByDate = importedVideos.reduce((acc, v, idx) => {
    const key = v.date || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push({ ...v, _index: idx });
    return acc;
  }, {});
  const sortedDates = Object.keys(videosByDate).sort().reverse();

  return (
    <View style={{ flex: 1, backgroundColor: DEEP }}>

      <Modal visible={!!importingFile} animationType="fade" transparent={false} statusBarTranslucent>
        <View style={styles.importScreen}>
          <Text style={styles.importScreenTitle}>📥 Importing Video</Text>
          <Text style={styles.importScreenFname} numberOfLines={2}>{importingFile?.fname}</Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round((importingFile?.progress||0)*100)}%` }]} />
          </View>
          <Text style={styles.progressPct}>{Math.round((importingFile?.progress||0)*100)}%</Text>
          <Text style={styles.importStatus}>{importingFile?.status}</Text>
        </View>
      </Modal>

      <Modal visible={!!pendingImport} animationType="slide" transparent onRequestClose={cancelImport}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Which session is this from?</Text>
            <Text style={styles.modalSubtitle} numberOfLines={1}>{pendingImport?.fname}</Text>
            {pendingImport?.videoStartUtc && (
              <Text style={styles.modalGps}>📍 GPS: {pendingImport.videoStartUtc}</Text>
            )}
            <FlatList
              data={allSessions}
              keyExtractor={item => item.session_id || item.date}
              style={styles.modalList}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalRow}
                  onPress={() => confirmSessionForImport(item.date, item.session_id, item.name)}
                >
                  <Text style={styles.modalRowTitle}>{item.name}</Text>
                  <Text style={styles.modalRowDate}>
                    {item.date}{item.start_time ? ` · ${item.start_time}` : ''}
                  </Text>
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity style={styles.modalCancelBtn} onPress={cancelImport}>
              <Text style={styles.modalCancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ScrollView contentContainerStyle={styles.container} style={styles.scrollBg}>
        <Header title="🎬 Video Library" />

        <FeatureGate feature="FULL_ANALYSIS" onUpgradePress={() => navigation.navigate('Upgrade')}>
          {null}
        </FeatureGate>

        <TouchableOpacity style={styles.importBtn} onPress={pickVideoFromPhone}>
          <Text style={styles.importBtnText}>📁 Import Video from Files</Text>
        </TouchableOpacity>
        {!!pickerError && <Text style={styles.errorText}>⚠️ {pickerError}</Text>}

        {activeVideo && (
          <View style={styles.playerWrap}>
            <Text style={styles.playerInfo}>{activeVideo.sessionName} — {activeVideo.fname}</Text>

            <VideoView
              player={player}
              style={styles.video}
              nativeControls
              contentFit="contain"
            />

            {!!playerError && <Text style={styles.errorText}>⚠️ {playerError}</Text>}

            <View style={styles.playerBtnRow}>
              <TouchableOpacity style={styles.closeBtn} onPress={closeVideo}>
                <Text style={styles.closeBtnText}>✕ Close</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.analyseSection}>
              <TouchableOpacity
                style={[styles.analyseBtn, analysing && styles.analyseBtnDisabled]}
                onPress={() => navigation.navigate('ClipSelector', {
                  videoUri: activeVideo.url,
                  sessionId: activeVideo.session_id,
                  sessionName: activeVideo.sessionName,
                  videoStartUtc: activeVideo.video_start_utc,
                  fname: activeVideo.fname,
                })}
                disabled={analysing}
              >
                {analysing
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.analyseBtnText}>🏄 Analyse Biomechanics</Text>
                }
              </TouchableOpacity>

              {analysing && analysisProgress.total > 0 && (
                <Text style={styles.analyseProgressText}>
                  Processing frame {analysisProgress.current} of {analysisProgress.total}…
                </Text>
              )}

              {!!analysisError && <Text style={styles.errorText}>⚠️ {analysisError}</Text>}

              {analysisResult && (
                <View style={styles.analyseResultBox}>
                  <Text style={styles.analyseResultTitle}>✅ Analysis complete</Text>
                  <TouchableOpacity
                    style={[styles.analyseBtn, { marginTop: 8, backgroundColor: SKY }]}
                    onPress={() => navigation.navigate('SessionDetail', { sessionId: analysisResult.sessionId })}
                  >
                    <Text style={styles.analyseBtnText}>📋 View Session Detail</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        )}

        {sortedDates.length === 0 && (
          <Text style={styles.emptyText}>
            No videos imported yet. Tap "Import Video from Files" to get started.
          </Text>
        )}

        {sortedDates.map(date => (
          <SharedCard key={date} style={styles.sessionCard}>
            <Text style={styles.sessionTitle}>{videosByDate[date][0]?.sessionName || date}</Text>
            <Text style={styles.sessionMeta}>
              {date} · {videosByDate[date].length} file{videosByDate[date].length > 1 ? 's' : ''}
            </Text>
            <View style={styles.fileRow}>
              {videosByDate[date].map(item => (
                <View key={item._index} style={styles.fileBtnWrap}>
                  <TouchableOpacity
                    style={[styles.fileBtn, styles.importedFileBtn]}
                    onPress={() => playVideo(item)}
                  >
                    <Text style={styles.fileBtnText}>📱 {item.fname}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.deleteBtn} onPress={() => deleteVideo(item._index)}>
                    <Text style={styles.deleteBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          </SharedCard>
        ))}
      </ScrollView>

      <WebView
        ref={movenetWebViewRef}
        source={{ html: MOVENET_HTML }}
        style={{ width: 0, height: 0, position: 'absolute' }}
        onMessage={handleWebViewMessage}
        javaScriptEnabled originWhitelist={['*']}
        onError={e => console.warn('[MoveNet WebView] error:', e.nativeEvent.description)}
      />
      <WebView
        ref={gpmfWebViewRef}
        source={{ html: GPMF_HTML }}
        style={{ width: 0, height: 0, position: 'absolute' }}
        onMessage={handleGPMFMessage}
        javaScriptEnabled originWhitelist={['*']}
        allowFileAccess allowUniversalAccessFromFileURLs
        onError={e => console.warn('[GPMF WebView] error:', e.nativeEvent.description)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scrollBg:  { backgroundColor: DEEP },
  container: { padding: 14, flexGrow: 1, paddingBottom: 40 },

  importScreen: {
    flex: 1, backgroundColor: DEEP,
    alignItems: 'center', justifyContent: 'center', padding: 30,
  },
  importScreenTitle: { color: TEXT, fontSize: 24, fontWeight: '700', marginBottom: 16 },
  importScreenFname: {
    color: 'rgba(205,232,240,0.6)', fontSize: 13,
    marginBottom: 40, textAlign: 'center',
  },
  importStatus: { color: TEXT, fontSize: 15, textAlign: 'center', marginTop: 8 },

  progressTrack: {
    width: '100%', height: 10,
    backgroundColor: 'rgba(26,138,181,0.2)',
    borderRadius: 5, overflow: 'hidden', marginBottom: 8,
  },
  progressFill: { height: '100%', backgroundColor: SKY, borderRadius: 5 },
  progressPct:  { color: SKY, fontSize: 13, fontWeight: '600', marginBottom: 12 },

  importBtn: {
    paddingVertical: 12, backgroundColor: SKY,
    borderRadius: 10, alignItems: 'center', marginBottom: 14,
  },
  importBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  emptyText: {
    color: 'rgba(205,232,240,0.4)', fontSize: 13,
    textAlign: 'center', marginTop: 40,
  },
  errorText: { color: DANGER, fontSize: 12, textAlign: 'center', marginTop: 8 },

  playerWrap: {
    backgroundColor: 'rgba(26,138,181,0.08)',
    borderWidth: 1, borderColor: 'rgba(26,138,181,0.2)',
    borderRadius: 12, padding: 10, marginBottom: 16,
  },
  playerInfo: {
    color: 'rgba(205,232,240,0.6)', fontSize: 12,
    textAlign: 'center', marginBottom: 8,
  },
  video: { width: '100%', height: 220, borderRadius: 12, backgroundColor: '#000' },

  playerBtnRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  closeBtn: {
    flex: 1, paddingVertical: 10,
    backgroundColor: 'rgba(26,138,181,0.1)',
    borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 8, alignItems: 'center',
  },
  closeBtnText: { color: TEXT, fontSize: 13 },

  analyseSection: { marginTop: 10 },
  analyseBtn: {
    paddingVertical: 12, backgroundColor: ACCENT,
    borderRadius: 10, alignItems: 'center',
  },
  analyseBtnDisabled: { opacity: 0.6 },
  analyseBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  analyseProgressText: {
    color: 'rgba(205,232,240,0.6)', fontSize: 12,
    textAlign: 'center', marginTop: 8,
  },
  analyseResultBox: {
    marginTop: 10, padding: 10,
    backgroundColor: 'rgba(26,138,181,0.1)',
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  analyseResultTitle: { color: SKY, fontSize: 13, fontWeight: '700', marginBottom: 4 },

  sessionCard:  { marginBottom: 10 },
  sessionTitle: { color: TEXT, fontWeight: '600', fontSize: 14, marginBottom: 4 },
  sessionMeta:  { color: 'rgba(205,232,240,0.4)', fontSize: 12, marginBottom: 8 },
  fileRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  fileBtnWrap:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
  fileBtn:      { paddingVertical: 6, paddingHorizontal: 10, backgroundColor: ACCENT, borderRadius: 8 },
  importedFileBtn: { backgroundColor: SKY },
  fileBtnText:  { color: '#fff', fontSize: 11, fontWeight: '500' },
  deleteBtn:    { paddingVertical: 6, paddingHorizontal: 8, backgroundColor: 'rgba(230,57,70,0.2)', borderRadius: 8 },
  deleteBtnText: { color: DANGER, fontSize: 11, fontWeight: '700' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalBox: {
    backgroundColor: DEEP, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 16, maxHeight: '75%',
    borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  modalTitle:    { color: TEXT, fontSize: 16, fontWeight: '700', marginBottom: 2 },
  modalSubtitle: { color: 'rgba(205,232,240,0.5)', fontSize: 12, marginBottom: 4 },
  modalGps:      { color: SKY, fontSize: 11, marginBottom: 8 },
  modalList:     { marginTop: 4 },
  modalRow: {
    paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: 'rgba(26,138,181,0.15)',
  },
  modalRowTitle: { color: TEXT, fontSize: 14, fontWeight: '500' },
  modalRowDate:  { color: 'rgba(205,232,240,0.4)', fontSize: 11, marginTop: 2 },
  modalCancelBtn: { marginTop: 12, paddingVertical: 10, alignItems: 'center' },
  modalCancelBtnText: { color: DANGER, fontSize: 13, fontWeight: '600' },
});

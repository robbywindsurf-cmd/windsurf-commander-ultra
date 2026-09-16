import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { WeatherBackfillService } from '../services/WeatherBackfillService';
import { RameHeadWindService } from '../services/RameHeadWindService';
import { HrBackfillService } from '../services/HrBackfillService';
import { AnalysisRepository, EmbeddingService, TierService, canAccess, LocalAI, getDb } from '@commandersuite/core';
import { colors } from '../theme';

const DEEP = colors.deep;
const SKY = colors.accent;
const TEXT = colors.text;
const ACCENT = '#f0a500';
const SAFE = '#2a9d8f';
const DANGER = colors.danger;

// RED — nothing indexed yet. AMBER — indexing is running, or some sessions
// are indexed but not all (stale relative to the latest session). GREEN —
// fully indexed and up to date.
function indexStatusColor(indexing, indexStatus) {
  if (indexing) return ACCENT;
  if (!indexStatus || indexStatus.indexed === 0) return DANGER;
  if (indexStatus.indexed < indexStatus.total) return ACCENT;
  return SAFE;
}

export default function SettingsScreen({ navigation }) {
  const [missingWeatherCount, setMissingWeatherCount] = useState(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState({ completed: 0, total: 0 });
  const [backfillResult, setBackfillResult] = useState(null);
  const [backfillError, setBackfillError] = useState('');

  useEffect(() => {
    WeatherBackfillService.countMissing().then(setMissingWeatherCount).catch(() => {});
  }, []);

  const [rameEligibleCount, setRameEligibleCount] = useState(null);
  const [rameRunning, setRameRunning] = useState(false);
  const [rameProgress, setRameProgress] = useState({ completed: 0, total: 0 });
  const [rameResult, setRameResult] = useState(null);
  const [rameError, setRameError] = useState('');

  useEffect(() => {
    RameHeadWindService.getEligibleSessions().then((s) => setRameEligibleCount(s.length)).catch(() => {});
  }, []);

  async function runRameHeadBackfill() {
    setRameRunning(true);
    setRameError('');
    setRameResult(null);
    setRameProgress({ completed: 0, total: 0 });
    try {
      const result = await RameHeadWindService.backfillAll((completed, total) => setRameProgress({ completed, total }));
      setRameResult(result);
    } catch (e) {
      setRameError(e.message || 'Rame Head backfill failed');
    } finally {
      setRameRunning(false);
    }
  }

  async function runWeatherBackfill() {
    setBackfillRunning(true);
    setBackfillError('');
    setBackfillResult(null);
    setBackfillProgress({ completed: 0, total: 0 });
    try {
      const result = await WeatherBackfillService.backfillAllSessions((completed, total) =>
        setBackfillProgress({ completed, total })
      );
      setBackfillResult(result);
      setMissingWeatherCount(await WeatherBackfillService.countMissing());
    } catch (e) {
      setBackfillError(e.message || 'Backfill failed');
    } finally {
      setBackfillRunning(false);
    }
  }

  const [hrMissingCount, setHrMissingCount] = useState(null);
  const [hrRunning, setHrRunning] = useState(false);
  const [hrProgress, setHrProgress] = useState({ completed: 0, total: 0 });
  const [hrResult, setHrResult] = useState(null);
  const [hrError, setHrError] = useState('');

  useEffect(() => {
    HrBackfillService.countMissing().then(setHrMissingCount).catch(() => {});
  }, []);

  async function runHrBackfill() {
    setHrRunning(true);
    setHrError('');
    setHrResult(null);
    setHrProgress({ completed: 0, total: 0 });
    try {
      const result = await HrBackfillService.backfillAllSessions((completed, total) =>
        setHrProgress({ completed, total })
      );
      setHrResult(result);
      setHrMissingCount(await HrBackfillService.countMissing());
    } catch (e) {
      setHrError(e.message || 'HR backfill failed');
    } finally {
      setHrRunning(false);
    }
  }

  const [tier, setTier] = useState(null);
  const [indexStatus, setIndexStatus] = useState(null); // { indexed, total, lastIndexedAt }
  const [indexing, setIndexing] = useState(false);
  const [indexPhase, setIndexPhase] = useState('sessions'); // 'sessions' | 'notes'
  const [indexProgress, setIndexProgress] = useState({ completed: 0, total: 0 });
  const [indexResult, setIndexResult] = useState(null); // { sessions, notes }
  const [indexError, setIndexError] = useState('');

  useEffect(() => {
    TierService.getCachedTier().then(setTier);
    EmbeddingService.getIndexStatus().then(setIndexStatus).catch(() => {});
  }, []);

  // rebuild=true clears every existing embedding first, so sessions that
  // were already indexed (and would otherwise be skipped) get regenerated
  // too — for when the embedded text itself changed (e.g. adding HR),
  // making old rows stale rather than just incomplete.
  async function runIndexAllSessions({ rebuild = false } = {}) {
    setIndexing(true);
    setIndexError('');
    setIndexResult(null);
    setIndexPhase('sessions');
    setIndexProgress({ completed: 0, total: 0 });
    try {
      if (rebuild) await EmbeddingService.clearAll();

      // Chat (LocalAI) and indexing (EmbeddingService) each open their own
      // llama.cpp context — if Chat was used earlier this session, its
      // context is still resident. Two live contexts competing for memory
      // is a likely cause of a native "Failed to load model" mid-index, so
      // free the chat one first; it reloads lazily next time it's needed.
      await LocalAI.release();

      const sessionsResult = await EmbeddingService.embedAllSessions((completed, total) =>
        setIndexProgress({ completed, total })
      );

      const notes = await AnalysisRepository.getAllCoachingNotes();
      setIndexPhase('notes');
      setIndexProgress({ completed: 0, total: notes.length });
      let notesIndexed = 0;
      for (let i = 0; i < notes.length; i++) {
        try {
          const id = await EmbeddingService.embedCoachingNote(notes[i]);
          if (id != null) notesIndexed += 1;
        } catch (err) {
          // One note failing to embed (e.g. the same native load issue
          // that can hit embedAllSessions) shouldn't abort the rest.
          console.warn('[Settings] coaching note embed failed:', err.message);
        }
        setIndexProgress({ completed: i + 1, total: notes.length });
      }

      setIndexResult({ sessions: sessionsResult.embedded, notes: notesIndexed });
      if (sessionsResult.failed > 0) {
        setIndexError(
          `${sessionsResult.failed} session${sessionsResult.failed === 1 ? '' : 's'} failed to embed` +
          (sessionsResult.lastError ? `: ${sessionsResult.lastError}` : '')
        );
      }
      setIndexStatus(await EmbeddingService.getIndexStatus());
    } catch (e) {
      setIndexError(e.message || 'Indexing failed');
    } finally {
      setIndexing(false);
    }
  }

  // TEMPORARY DEBUG — remove once the beach-check weather caching issue is
  // confirmed fixed. Dumps the 10 most recently fetched weather_cache rows
  // so it's immediately visible whether the cache is empty, has stale
  // dates, or has the wrong beach name.
  async function checkWeatherCache() {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT beach_name, forecast_date, best_wind_kn, fetched_at
       FROM weather_cache
       ORDER BY fetched_at DESC
       LIMIT 10`
    );
    console.log('[Debug] weather_cache:', JSON.stringify(rows));
    Alert.alert(
      'Weather Cache',
      rows.length === 0
        ? 'Empty — no weather data cached'
        : rows.map((r) => `${r.beach_name} ${r.forecast_date} ${r.best_wind_kn}kn`).join('\n')
    );
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container} style={styles.scrollBg}>
      <Header title="⚙️ Settings" />

      <Text style={styles.sectionLabel}>🌦️ Backfill Historical Weather</Text>
      <SharedCard style={styles.previewCard}>
        {missingWeatherCount == null ? (
          <Text style={styles.previewName}>Checking weather coverage…</Text>
        ) : (
          <Text style={styles.previewName}>
            {missingWeatherCount} session date{missingWeatherCount === 1 ? '' : 's'} missing weather data
          </Text>
        )}
      </SharedCard>

      {!backfillRunning && !backfillResult && missingWeatherCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={runWeatherBackfill}>
          <Text style={styles.importBtnText}>🌦️ Backfill Historical Weather</Text>
        </TouchableOpacity>
      )}

      {backfillRunning && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>Fetching from Open-Meteo…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${backfillProgress.total ? Math.round((backfillProgress.completed / backfillProgress.total) * 100) : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.progressCount}>
            {backfillProgress.completed} / {backfillProgress.total} sessions
          </Text>
        </SharedCard>
      )}

      {!!backfillError && <Text style={styles.errorText}>⚠️ {backfillError}</Text>}

      {backfillResult && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>{backfillResult.success ? '✅' : '⚠️'}</Text>
            <Text style={[styles.resultTitle, { color: backfillResult.success ? SAFE : ACCENT }]}>
              {backfillResult.count} date{backfillResult.count === 1 ? '' : 's'} backfilled
            </Text>
            {backfillResult.errors.length > 0 && (
              <Text style={styles.resultSub}>{backfillResult.errors.length} error(s) — check network and retry</Text>
            )}
          </View>
        </SharedCard>
      )}

      <Text style={styles.sectionLabel}>🎯 Rame Head Wind Backfill</Text>
      <SharedCard style={styles.previewCard}>
        {rameEligibleCount == null ? (
          <Text style={styles.previewName}>Checking sessions in range…</Text>
        ) : (
          <>
            <Text style={styles.previewName}>
              {rameEligibleCount} session{rameEligibleCount === 1 ? '' : 's'} near Rame Head
            </Text>
            <Text style={styles.previewSize}>
              Uses Rame Head NCI lookout data — more accurate than Open-Meteo for sessions near Torpoint
            </Text>
          </>
        )}
      </SharedCard>

      {!rameRunning && !rameResult && rameEligibleCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={runRameHeadBackfill}>
          <Text style={styles.importBtnText}>🎯 Backfill from Rame Head</Text>
        </TouchableOpacity>
      )}

      {rameRunning && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>Fetching from Rame Head NCI archive…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${rameProgress.total ? Math.round((rameProgress.completed / rameProgress.total) * 100) : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.progressCount}>
            {rameProgress.completed} / {rameProgress.total} sessions
          </Text>
        </SharedCard>
      )}

      {!!rameError && <Text style={styles.errorText}>⚠️ {rameError}</Text>}

      {rameResult && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>✅</Text>
            <Text style={[styles.resultTitle, { color: SAFE }]}>
              {rameResult.updated} of {rameResult.total} updated
            </Text>
            <Text style={styles.resultSub}>{rameResult.skipped} skipped (existing data was better)</Text>
            {rameResult.failed > 0 && <Text style={styles.resultSub}>{rameResult.failed} failed</Text>}
          </View>
        </SharedCard>
      )}

      <Text style={styles.sectionLabel}>❤️ Heart Rate Backfill</Text>
      <SharedCard style={styles.previewCard}>
        {hrMissingCount == null ? (
          <Text style={styles.previewName}>Checking sessions…</Text>
        ) : (
          <>
            <Text style={styles.previewName}>
              {hrMissingCount} session{hrMissingCount === 1 ? '' : 's'} missing HR data
            </Text>
            <Text style={styles.previewSize}>
              Aggregates avg/max heart rate from imported GPS trackpoints — needed for the AI coach to reference HR (e.g. "HR vs speed")
            </Text>
          </>
        )}
      </SharedCard>

      {!hrRunning && !hrResult && hrMissingCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={runHrBackfill}>
          <Text style={styles.importBtnText}>❤️ Backfill Heart Rate</Text>
        </TouchableOpacity>
      )}

      {hrRunning && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>Aggregating trackpoint HR…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${hrProgress.total ? Math.round((hrProgress.completed / hrProgress.total) * 100) : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.progressCount}>
            {hrProgress.completed} / {hrProgress.total} sessions
          </Text>
        </SharedCard>
      )}

      {!!hrError && <Text style={styles.errorText}>⚠️ {hrError}</Text>}

      {hrResult && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>✅</Text>
            <Text style={[styles.resultTitle, { color: SAFE }]}>
              {hrResult.updated} session{hrResult.updated === 1 ? '' : 's'} updated
            </Text>
            <Text style={styles.resultSub}>{hrResult.skipped} skipped (no trackpoint HR data, or already set)</Text>
            {hrResult.errors.length > 0 && <Text style={styles.resultSub}>{hrResult.errors.length} failed</Text>}
          </View>
        </SharedCard>
      )}

      <Text style={styles.sectionLabel}>🧠 AI Semantic Search</Text>
      {tier === null ? (
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewName}>Checking access…</Text>
        </SharedCard>
      ) : !canAccess('FULL_ANALYSIS', tier) ? (
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewName}>🔒 AI Semantic Search is a Premium feature</Text>
          <Text style={styles.previewSize}>Index your sessions for smarter AI coaching</Text>
        </SharedCard>
      ) : (
        <>
          <SharedCard style={styles.previewCard}>
            {!indexStatus ? (
              <Text style={styles.previewName}>Checking index status…</Text>
            ) : (
              <>
                <View style={styles.statusRow}>
                  <View style={[styles.statusDot, { backgroundColor: indexStatusColor(indexing, indexStatus) }]} />
                  <Text style={styles.previewName}>
                    {indexStatus.indexed > 0
                      ? `${indexStatus.indexed} of ${indexStatus.total} sessions indexed`
                      : 'Not indexed yet'}
                  </Text>
                </View>
                {indexStatus.lastIndexedAt && (
                  <Text style={styles.previewSize}>Last indexed: {indexStatus.lastIndexedAt}</Text>
                )}
                <Text style={styles.previewSize}>
                  Embeddings run on-device via the already-downloaded Phi-3 Mini model — first indexing may take several minutes.
                </Text>
              </>
            )}
          </SharedCard>

          {!indexing && !indexResult && indexStatus && indexStatus.indexed < indexStatus.total && (
            <>
              <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={() => runIndexAllSessions()}>
                <Text style={styles.importBtnText}>🧠 Index All Sessions</Text>
              </TouchableOpacity>
              <Text style={styles.estimateText}>
                ~{(indexStatus.total - indexStatus.indexed) * 3} seconds estimated
              </Text>
            </>
          )}

          {!indexing && !indexResult && indexStatus && indexStatus.indexed > 0 && (
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.viewImportBtn}
              onPress={() => runIndexAllSessions({ rebuild: true })}
            >
              <Text style={styles.viewImportBtnText}>♻️ Rebuild Index (re-embed everything)</Text>
            </TouchableOpacity>
          )}

          {indexing && (
            <SharedCard style={styles.progressCard}>
              <Text style={styles.progressLabel}>
                {indexPhase === 'notes' ? 'Indexing coaching notes…' : 'Indexing sessions…'}
              </Text>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${indexProgress.total ? Math.round((indexProgress.completed / indexProgress.total) * 100) : 0}%` },
                  ]}
                />
              </View>
              <Text style={styles.progressCount}>
                {indexProgress.completed} / {indexProgress.total} {indexPhase === 'notes' ? 'coaching notes' : 'sessions'}
              </Text>
            </SharedCard>
          )}

          {!!indexError && <Text style={styles.errorText}>⚠️ {indexError}</Text>}

          {indexResult && (
            <SharedCard style={styles.resultCard}>
              <View style={styles.resultCenter}>
                <Text style={styles.resultIcon}>✅</Text>
                <Text style={[styles.resultTitle, { color: SAFE }]}>
                  {indexResult.sessions} session{indexResult.sessions === 1 ? '' : 's'} indexed
                </Text>
                {indexResult.notes > 0 && (
                  <Text style={styles.resultSub}>
                    + {indexResult.notes} coaching note{indexResult.notes === 1 ? '' : 's'} indexed
                  </Text>
                )}
              </View>
            </SharedCard>
          )}
        </>
      )}

      <TouchableOpacity activeOpacity={0.7} style={styles.viewImportBtn} onPress={() => navigation.navigate('ImportData')}>
        <Text style={styles.viewImportBtnText}>📥 Import Historical Data (CSV)</Text>
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.7} style={styles.viewImportBtn} onPress={checkWeatherCache}>
        <Text style={styles.viewImportBtnText}>🐛 Check Weather Cache (debug)</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: DEEP },
  container: { padding: 14, flexGrow: 1, paddingBottom: 40 },

  sectionLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(205,232,240,0.35)', marginBottom: 6 },

  previewCard: { marginBottom: 12 },
  previewName: { color: TEXT, fontSize: 13, fontWeight: '600' },
  previewSize: { color: 'rgba(205,232,240,0.4)', fontSize: 10, marginTop: 2 },

  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 9, height: 9, borderRadius: 4.5, marginRight: 7 },

  importBtn: {
    flexDirection: 'row',
    backgroundColor: SKY,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  importBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  estimateText: { color: 'rgba(205,232,240,0.4)', fontSize: 11, textAlign: 'center', marginTop: -4, marginBottom: 10 },

  errorText: { color: DANGER, textAlign: 'center', fontSize: 13, marginBottom: 10 },

  progressCard: { marginBottom: 12 },
  progressLabel: { color: TEXT, fontSize: 13, fontWeight: '600', marginBottom: 8 },
  progressTrack: {
    height: 8,
    backgroundColor: 'rgba(205,232,240,0.15)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: { height: 8, backgroundColor: ACCENT, borderRadius: 4 },
  progressCount: { color: 'rgba(205,232,240,0.4)', fontSize: 11, marginTop: 6, textAlign: 'right' },

  resultCard: { marginBottom: 12 },
  resultCenter: { alignItems: 'center', paddingVertical: 4 },
  resultIcon: { fontSize: 26, marginBottom: 6 },
  resultTitle: { fontSize: 22, fontWeight: '700', letterSpacing: 1 },
  resultSub: { color: 'rgba(205,232,240,0.5)', fontSize: 12, marginTop: 4, textAlign: 'center' },

  viewImportBtn: {
    width: '100%',
    marginTop: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(26,138,181,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 12,
    alignItems: 'center',
  },
  viewImportBtnText: { color: TEXT, fontSize: 13, fontWeight: '500' },
});

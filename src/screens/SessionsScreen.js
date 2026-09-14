import React, { useCallback, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, StyleSheet, Modal, View, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SessionRepository, EquipmentRepository, TrackpointRepository } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import SessionMapPreview from '../components/SessionMapPreview';
import { pickFitFile, importFitFile, repairLegacyTrackpoints } from '../services/FITImporter';
import { colors } from '../theme';

function formatDistanceKm(distanceM) {
  return distanceM ? `${(distanceM / 1000).toFixed(1)} km` : null;
}

function formatDurationMin(durationS) {
  return durationS ? `${Math.round(durationS / 60)} min` : null;
}

// Only the most recent sessions get a map preview — with real historical
// data, loading (even sampled) trackpoints for every session at once was
// what crashed this screen. Everything older is summary-only.
const MAP_PREVIEW_COUNT = 3;

export default function SessionsScreen({ navigation }) {
  const [sessions, setSessions] = useState([]);
  const [gearCombos, setGearCombos] = useState({});
  const [trackpointsBySession, setTrackpointsBySession] = useState({});
  const [importing, setImporting] = useState(null); // { status, pct } | null
  const [importResult, setImportResult] = useState(null); // { duplicate, session } | null
  const [importError, setImportError] = useState(null);
  const [gearPromptSessionId, setGearPromptSessionId] = useState(null);

  const load = useCallback(async () => {
    try {
      await repairLegacyTrackpoints();
      const [all, combos] = await Promise.all([
        SessionRepository.getAll(),
        EquipmentRepository.getGearCombos(),
      ]);
      setSessions(all);
      setGearCombos(Object.fromEntries(combos.map((c) => [c.id, c])));

      const recent = all.slice(0, MAP_PREVIEW_COUNT);
      const tpEntries = await Promise.all(
        recent.map(async (s) => [s.session_id, await TrackpointRepository.getSampledForSession(s.session_id, 80)])
      );
      setTrackpointsBySession(Object.fromEntries(tpEntries));
    } catch (err) {
      console.warn('[Sessions] load error:', err.message);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleImportFit() {
    setImportError(null);
    setImportResult(null);
    try {
      const asset = await pickFitFile();
      if (!asset) return;

      setImporting({ status: 'Starting…', pct: 0 });
      const result = await importFitFile(asset, {
        onProgress: (status, pct) => setImporting({ status, pct }),
      });

      setImporting(null);
      setImportResult(result);
      await load();
      if (!result.duplicate) setGearPromptSessionId(result.sessionId);
    } catch (err) {
      setImporting(null);
      setImportError(err.message || 'Import failed.');
    }
  }

  async function assignGear(comboId) {
    if (gearPromptSessionId) {
      await SessionRepository.setGearCombo(gearPromptSessionId, comboId);
      await load();
    }
    setGearPromptSessionId(null);
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={`${sessions.length} sessions`} title="📅 Sessions" />

      <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={handleImportFit}>
        <Text style={styles.importBtnText}>📥 Import FIT File</Text>
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.7}
        style={styles.importHistoricalBtn}
        onPress={() => navigation.navigate('ImportData')}
        accessibilityLabel="Import historical data"
      >
        <Text style={styles.importHistoricalBtnText}>🗄️ Import historical data</Text>
      </TouchableOpacity>

      {!!importError && <Text style={styles.errorText}>⚠️ {importError}</Text>}

      {importResult && (
        <SharedCard>
          {importResult.duplicate ? (
            <Text style={styles.resultText}>⚠️ This session is already imported.</Text>
          ) : (
            <>
              <Text style={styles.resultTitle}>✅ Session imported</Text>
              <Text style={styles.resultText}>
                {importResult.session.date} · {importResult.session.durationMinutes ?? '—'} min
              </Text>
              <Text style={styles.resultText}>
                {importResult.session.trackpoints.toLocaleString()} trackpoints · Peak {importResult.session.maxSpeedKn ?? '—'} kn
                {importResult.session.distanceKm != null ? ` · ${importResult.session.distanceKm} km` : ''}
              </Text>
            </>
          )}
        </SharedCard>
      )}

      {sessions.length === 0 ? (
        <Text style={styles.emptyText}>No sessions yet. Import a FIT file to get started.</Text>
      ) : (
        sessions.map((s, i) => {
          const gear = gearCombos[s.gear_combo_id];
          const stats = [
            s.max_speed_kn != null ? `${s.max_speed_kn.toFixed(1)} kn max` : 'No speed data',
            formatDistanceKm(s.distance_m),
            formatDurationMin(s.duration_s),
          ].filter(Boolean).join(' · ');

          const goToDetail = () => navigation.navigate('SessionDetail', { sessionId: s.session_id });
          const showMap = i < MAP_PREVIEW_COUNT;

          return (
            <TouchableOpacity activeOpacity={0.7} key={s.session_id} onPress={goToDetail}>
              <SharedCard>
                <Text style={styles.title}>{s.date} {s.start_time ? `· ${s.start_time}` : ''}</Text>
                <Text style={styles.meta}>{stats}</Text>
                {gear && (
                  <Text style={styles.gear}>
                    🏄 {[gear.board_name, gear.sail_name && `${gear.sail_name}${gear.sail_size ? ` ${gear.sail_size}m` : ''}`, gear.fin_name]
                      .filter(Boolean).join(' · ')}
                  </Text>
                )}
                {showMap && <SessionMapPreview trackpoints={trackpointsBySession[s.session_id]} onPress={goToDetail} />}
              </SharedCard>
            </TouchableOpacity>
          );
        })
      )}

      <Modal statusBarTranslucent visible={!!gearPromptSessionId} animationType="slide" transparent onRequestClose={() => setGearPromptSessionId(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.gearPromptBox}>
            <Text style={styles.modalTitle}>Which gear did you use?</Text>
            {Object.values(gearCombos).length === 0 ? (
              <Text style={styles.resultText}>No gear combos yet — add one in the Garage tab.</Text>
            ) : (
              Object.values(gearCombos).map((c) => (
                <TouchableOpacity activeOpacity={0.7} key={c.id} style={styles.gearOption} onPress={() => assignGear(c.id)}>
                  <Text style={styles.gearOptionName}>{c.name}</Text>
                  <Text style={styles.gearOptionMeta}>
                    {[c.board_name, c.sail_name].filter(Boolean).join(' + ')}
                  </Text>
                </TouchableOpacity>
              ))
            )}
            <TouchableOpacity activeOpacity={0.7} style={styles.skipBtn} onPress={() => setGearPromptSessionId(null)}>
              <Text style={styles.skipBtnText}>Skip</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={!!importing} animationType="fade" transparent statusBarTranslucent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <ActivityIndicator color={colors.accent} size="large" style={{ marginBottom: 12 }} />
            <Text style={styles.modalStatus}>{importing?.status}</Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round((importing?.pct || 0) * 100)}%` }]} />
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  title: { color: colors.text, fontWeight: '600', fontSize: 14, marginBottom: 4 },
  meta: { color: 'rgba(205,232,240,0.5)', fontSize: 12 },
  gear: { color: colors.accent, fontSize: 11, marginTop: 6 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },

  importBtn: {
    backgroundColor: colors.accent, paddingVertical: 12, borderRadius: 12,
    alignItems: 'center', marginBottom: 12,
  },
  importBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  importHistoricalBtn: {
    backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
    paddingVertical: 10, borderRadius: 12, alignItems: 'center', marginBottom: 12,
  },
  importHistoricalBtnText: { color: colors.text, fontWeight: '600', fontSize: 13 },
  errorText: { color: colors.danger, fontSize: 12, textAlign: 'center', marginBottom: 10 },
  resultTitle: { color: colors.text, fontWeight: '700', fontSize: 14, marginBottom: 4 },
  resultText: { color: 'rgba(205,232,240,0.7)', fontSize: 12, marginBottom: 2 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  gearPromptBox: {
    width: '85%', backgroundColor: colors.deep, borderRadius: 14, padding: 20,
    borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  gearOption: {
    backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  gearOptionName: { color: colors.text, fontWeight: '700', fontSize: 14 },
  gearOptionMeta: { color: 'rgba(205,232,240,0.5)', fontSize: 12, marginTop: 2 },
  skipBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 4 },
  skipBtnText: { color: 'rgba(205,232,240,0.5)', fontSize: 13, fontWeight: '600' },
  modalBox: {
    width: '80%', backgroundColor: colors.deep, borderRadius: 14, padding: 20,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  modalStatus: { color: colors.text, fontSize: 13, textAlign: 'center', marginBottom: 12 },
  progressTrack: {
    width: '100%', height: 8, backgroundColor: 'rgba(26,138,181,0.2)',
    borderRadius: 4, overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 4 },
});

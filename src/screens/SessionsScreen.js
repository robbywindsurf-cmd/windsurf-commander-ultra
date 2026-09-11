import React, { useCallback, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, StyleSheet, Modal, View, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SessionRepository } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { pickFitFile, importFitFile } from '../services/FITImporter';
import { colors } from '../theme';

export default function SessionsScreen({ navigation }) {
  const [sessions, setSessions] = useState([]);
  const [importing, setImporting] = useState(null); // { status, pct } | null
  const [importResult, setImportResult] = useState(null); // { duplicate, session } | null
  const [importError, setImportError] = useState(null);

  const load = useCallback(async () => {
    try {
      const all = await SessionRepository.getAll();
      setSessions(all);
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
    } catch (err) {
      setImporting(null);
      setImportError(err.message || 'Import failed.');
    }
  }

  return (
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={`${sessions.length} sessions`} title="📅 Sessions" />

      <TouchableOpacity style={styles.importBtn} onPress={handleImportFit}>
        <Text style={styles.importBtnText}>📥 Import FIT File</Text>
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
        sessions.map((s) => (
          <TouchableOpacity
            key={s.session_id}
            onPress={() => navigation.navigate('SessionDetail', { sessionId: s.session_id })}
          >
            <SharedCard>
              <Text style={styles.title}>{s.date} {s.start_time ? `· ${s.start_time}` : ''}</Text>
              <Text style={styles.meta}>
                {s.max_speed_kn ? `${s.max_speed_kn.toFixed(1)} kn max` : 'No speed data'}
                {s.distance_m ? ` · ${(s.distance_m / 1000).toFixed(1)} km` : ''}
                {s.duration_s ? ` · ${Math.round(s.duration_s / 60)} min` : ''}
              </Text>
            </SharedCard>
          </TouchableOpacity>
        ))
      )}

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
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },

  importBtn: {
    backgroundColor: colors.accent, paddingVertical: 12, borderRadius: 12,
    alignItems: 'center', marginBottom: 12,
  },
  importBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  errorText: { color: colors.danger, fontSize: 12, textAlign: 'center', marginBottom: 10 },
  resultTitle: { color: colors.text, fontWeight: '700', fontSize: 14, marginBottom: 4 },
  resultText: { color: 'rgba(205,232,240,0.7)', fontSize: 12, marginBottom: 2 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
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

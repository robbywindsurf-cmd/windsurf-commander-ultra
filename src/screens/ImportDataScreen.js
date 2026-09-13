import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Papa from 'papaparse';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { initDb } from '../db/schema';
import { sessionExists, insertSession } from '../db/sessions';
import { findOrCreateEquipment } from '../db/equipment';

const DEEP = '#061f2e';
const SKY = '#1a8ab5';
const ACCENT = '#f0a500';
const TEXT = '#cde8f0';
const SAFE = '#2a9d8f';
const DANGER = '#e63946';

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

async function mapRowToSession(row) {
  const boardId = row.board_name
    ? await findOrCreateEquipment('board', row.board_name, row.board_brand, row.board_size)
    : null;
  const sailId = row.sail_name
    ? await findOrCreateEquipment('sail', row.sail_name, row.sail_brand, row.sail_size)
    : null;

  const durationMinutes = toNumberOrNull(row.duration_minutes);

  return {
    session_id: row.session_id,
    notes: row.session_name ?? null,
    date: row.session_date ?? null,
    start_time: row.start_time ?? null,
    end_time: row.end_time ?? null,
    duration_s: durationMinutes != null ? Math.round(durationMinutes * 60) : null,
    max_speed_kn: toNumberOrNull(row.peak_speed_knots),
    avg_speed_kn: toNumberOrNull(row.avg_speed_knots),
    total_trackpoints: toNumberOrNull(row.total_trackpoints),
    board_id: boardId,
    sail_id: sailId,
    fin_name: row.fin_name ?? null,
    fin_size: row.fin_size ?? null,
    wind_speed: toNumberOrNull(row.wind_speed),
    wind_direction: row.wind_direction ?? null,
    temperature: toNumberOrNull(row.temperature),
    lat: toNumberOrNull(row.rep_lat),
    lon: toNumberOrNull(row.rep_lon),
    session_type: row.session_type ?? null,
  };
}

export default function ImportDataScreen({ navigation }) {
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [totalRows, setTotalRows] = useState(0);
  const [processedRows, setProcessedRows] = useState(0);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [done, setDone] = useState(false);

  async function pickFile() {
    try {
      setErrorMsg('');
      setDone(false);
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'public.comma-separated-values-text', '*/*'],
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets || !picked.assets[0]) return;
      const asset = picked.assets[0];
      if (!asset.name.toLowerCase().endsWith('.csv')) {
        setErrorMsg('Please select a .csv file');
        return;
      }
      setFile(asset);
      setTotalRows(0);
      setProcessedRows(0);
      setImportedCount(0);
      setSkippedCount(0);
    } catch (e) {
      setErrorMsg(e.message);
    }
  }

  async function startImport() {
    if (!file) return;
    setParsing(true);
    setErrorMsg('');
    setDone(false);

    try {
      const csvText = await FileSystem.readAsStringAsync(file.uri);
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      if (parsed.errors && parsed.errors.length > 0) {
        throw new Error(parsed.errors[0].message);
      }

      const rows = parsed.data.filter((r) => r.session_id);
      setTotalRows(rows.length);
      setParsing(false);
      setImporting(true);

      await initDb();

      let imported = 0;
      let skipped = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const exists = await sessionExists(row.session_id);
        if (exists) {
          skipped += 1;
        } else {
          const session = await mapRowToSession(row);
          await insertSession(session);
          imported += 1;
        }
        setProcessedRows(i + 1);
        setImportedCount(imported);
        setSkippedCount(skipped);
      }

      setImporting(false);
      setDone(true);
    } catch (e) {
      setErrorMsg(e.message || 'Import failed');
      setParsing(false);
      setImporting(false);
    }
  }

  const progress = totalRows > 0 ? processedRows / totalRows : 0;
  const busy = parsing || importing;

  return (
    <ScrollView contentContainerStyle={styles.container} style={styles.scrollBg}>
      <Header title="📥 Import Historical Data" />

      <View style={styles.hero}>
        <Text style={styles.heroIcon}>🗄️</Text>
        <Text style={styles.heroTitle}>Import Historical Data</Text>
        <Text style={styles.heroSub}>CSV export from Oracle PostgreSQL</Text>
      </View>

      <Text style={styles.sectionLabel}>📁 Select CSV File</Text>
      <TouchableOpacity
        style={[styles.dropZone, file && styles.dropZoneActive]}
        onPress={pickFile}
        disabled={busy}
        accessibilityLabel="Tap to select CSV file"
      >
        <Text style={styles.dropIcon}>📄</Text>
        <Text style={styles.dropTitle}>Tap to select CSV file</Text>
        <Text style={styles.dropSub}>Historical sessions export</Text>
      </TouchableOpacity>

      {file && (
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewLabel}>📋 File Selected</Text>
          <Text style={styles.previewName}>{file.name}</Text>
          <Text style={styles.previewSize}>{file.size ? (file.size / 1024).toFixed(1) + ' KB' : '—'}</Text>
        </SharedCard>
      )}

      {file && !done && (
        <TouchableOpacity style={[styles.importBtn, busy && styles.importBtnDisabled]} onPress={startImport} disabled={busy}>
          {busy && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
          <Text style={styles.importBtnText}>
            {parsing ? 'Parsing CSV...' : importing ? 'Importing...' : '📥 Import Sessions'}
          </Text>
        </TouchableOpacity>
      )}

      {!!errorMsg && <Text style={styles.errorText}>⚠️ {errorMsg}</Text>}

      {(importing || done) && totalRows > 0 && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>
            {totalRows} session{totalRows === 1 ? '' : 's'} found in CSV
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
          <Text style={styles.progressCount}>
            {processedRows} / {totalRows} processed
          </Text>
        </SharedCard>
      )}

      {done && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>✅</Text>
            <Text style={[styles.resultTitle, { color: SAFE }]}>Import Complete</Text>
            <Text style={styles.resultSub}>
              {importedCount} imported, {skippedCount} skipped (duplicates)
            </Text>

            <TouchableOpacity
              style={styles.viewSessionsBtn}
              onPress={() => navigation.navigate('MainTabs', { screen: 'Sessions' })}
            >
              <Text style={styles.viewSessionsBtnText}>📅 View in Sessions</Text>
            </TouchableOpacity>
          </View>
        </SharedCard>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: DEEP },
  container: { padding: 14, flexGrow: 1, paddingBottom: 40 },

  hero: {
    backgroundColor: 'rgba(26,138,181,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  heroIcon: { fontSize: 34, marginBottom: 6 },
  heroTitle: { color: '#fff', fontSize: 20, fontWeight: '700', letterSpacing: 1 },
  heroSub: { color: 'rgba(205,232,240,0.5)', fontSize: 11, marginTop: 2 },

  sectionLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(205,232,240,0.35)', marginBottom: 6 },

  dropZone: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'rgba(26,138,181,0.25)',
    backgroundColor: 'rgba(26,138,181,0.1)',
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    marginBottom: 12,
  },
  dropZoneActive: { borderColor: SKY, backgroundColor: 'rgba(26,138,181,0.15)' },
  dropIcon: { fontSize: 32, marginBottom: 8 },
  dropTitle: { color: TEXT, fontSize: 14, fontWeight: '600' },
  dropSub: { color: 'rgba(205,232,240,0.4)', fontSize: 11, marginTop: 4, textAlign: 'center' },

  previewCard: { marginBottom: 12 },
  previewLabel: { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 6 },
  previewName: { color: TEXT, fontSize: 13, fontWeight: '600' },
  previewSize: { color: 'rgba(205,232,240,0.4)', fontSize: 10, marginTop: 2 },

  importBtn: {
    flexDirection: 'row',
    backgroundColor: SKY,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  importBtnDisabled: { opacity: 0.7 },
  importBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

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

  viewSessionsBtn: {
    width: '100%',
    marginTop: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(26,138,181,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 12,
    alignItems: 'center',
  },
  viewSessionsBtnText: { color: TEXT, fontSize: 13, fontWeight: '500' },
});

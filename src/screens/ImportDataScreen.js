import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Papa from 'papaparse';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { SessionRepository, EquipmentRepository, TrackpointRepository, WeatherRepository, TideRepository, EmbeddingService, TierService, canAccess } from '@commandersuite/core';
import { WeatherBackfillService } from '../services/WeatherBackfillService';

// Trackpoint CSV files run to hundreds of thousands of rows / tens of MB —
// never load the whole thing into memory. Read fixed-size byte windows,
// parse whatever complete lines they contain, and carry any trailing
// partial line over to the next read.
const TP_READ_CHUNK_BYTES = 256 * 1024;
// Rows accumulated before a DB write + progress update (the "chunks of
// 1000 rows" the parser works in) — actual SQL statements are batched
// smaller than this, inside insertBatch.
const TP_PARSE_CHUNK_ROWS = 1000;

function toNumberOrNullTP(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

// First pass: count data rows (total minus header) by scanning for '\n'
// bytes in the same fixed-size windows, without parsing anything — gives
// the "X / Y trackpoints" denominator before the real import pass starts.
async function countCsvDataRows(uri, fileSize) {
  let position = 0;
  let newlineCount = 0;
  let endsWithNewline = true;

  while (position < fileSize) {
    const length = Math.min(TP_READ_CHUNK_BYTES, fileSize - position);
    const chunk = await FileSystem.readAsStringAsync(uri, { position, length, encoding: 'utf8' });
    position += length;
    newlineCount += (chunk.match(/\n/g) || []).length;
    endsWithNewline = chunk.endsWith('\n');
  }

  const totalLines = newlineCount + (endsWithNewline ? 0 : 1);
  return Math.max(0, totalLines - 1); // minus header row
}

async function importTrackpointsCsv(file, onProgress) {
  const fileSize = file.size;
  let position = 0;
  let leftover = '';
  let headerCols = null;
  let rowBuffer = [];
  let totalImported = 0;

  while (position < fileSize) {
    const length = Math.min(TP_READ_CHUNK_BYTES, fileSize - position);
    const chunk = await FileSystem.readAsStringAsync(file.uri, { position, length, encoding: 'utf8' });
    position += length;
    const atEOF = position >= fileSize;

    const text = leftover + chunk;
    let lines = text.split('\n');
    leftover = atEOF ? '' : lines.pop();

    const parsed = Papa.parse(lines.join('\n'), { skipEmptyLines: true });
    for (const values of parsed.data) {
      if (!headerCols) {
        headerCols = values.map((h) => h.trim());
        continue;
      }
      const row = {};
      headerCols.forEach((col, idx) => { row[col] = values[idx]; });

      rowBuffer.push({
        session_id: row.session_id,
        timestamp: row.timestamp,
        lat: toNumberOrNullTP(row.lat),
        lon: toNumberOrNullTP(row.lon),
        speed_ms: toNumberOrNullTP(row.speed),
        course: toNumberOrNullTP(row.course),
        hr: toNumberOrNullTP(row.hr),
        elevation: toNumberOrNullTP(row.elevation),
      });

      if (rowBuffer.length >= TP_PARSE_CHUNK_ROWS) {
        await TrackpointRepository.insertBatch(rowBuffer);
        totalImported += rowBuffer.length;
        onProgress(totalImported);
        rowBuffer = [];
      }
    }
  }

  if (rowBuffer.length) {
    await TrackpointRepository.insertBatch(rowBuffer);
    totalImported += rowBuffer.length;
    onProgress(totalImported);
  }

  await TrackpointRepository.rebuildTimestampIndex();
  return totalImported;
}

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

// Finds an equipment row by type + name + size within an already-fetched
// list, inserting (and appending to the list) if it doesn't exist yet —
// avoids re-querying getAll() for every CSV row.
async function findOrCreateEquipment(cache, type, name, brand, size) {
  if (!name) return null;
  const existing = cache.find((e) => e.type === type && e.name === name && (e.size || null) === (size || null));
  if (existing) return existing.id;

  const result = await EquipmentRepository.insert({ type, name, brand: brand || null, size: size || null });
  const id = result.lastInsertRowId;
  cache.push({ id, type, name, brand: brand || null, size: size || null });
  return id;
}

// Finds a gear combo by board/sail/fin ids within an already-fetched list,
// inserting (and appending) if it doesn't exist yet.
async function findOrCreateGearCombo(cache, boardId, sailId, finId, name) {
  if (!boardId && !sailId && !finId) return null;
  const existing = cache.find(
    (c) => (c.board_id || null) === (boardId || null) && (c.sail_id || null) === (sailId || null) && (c.fin_id || null) === (finId || null)
  );
  if (existing) return existing.id;

  const result = await EquipmentRepository.insertGearCombo({ name, board_id: boardId, sail_id: sailId, fin_id: finId });
  const id = result.lastInsertRowId;
  cache.push({ id, board_id: boardId, sail_id: sailId, fin_id: finId, name });
  return id;
}

async function mapRowToSession(row, equipmentCache, gearComboCache) {
  const boardId = await findOrCreateEquipment(equipmentCache, 'board', row.board_name, row.board_brand, row.board_size);
  const sailId = await findOrCreateEquipment(equipmentCache, 'sail', row.sail_name, row.sail_brand, row.sail_size);
  const finId = await findOrCreateEquipment(equipmentCache, 'fin', row.fin_name, null, row.fin_size);

  const gearComboName = [row.board_name, row.sail_name].filter(Boolean).join(' / ') || null;
  const gearComboId = await findOrCreateGearCombo(gearComboCache, boardId, sailId, finId, gearComboName);

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
    gear_combo_id: gearComboId,
    lat: toNumberOrNull(row.rep_lat),
    lon: toNumberOrNull(row.rep_lon),
  };
}

function safeJsonParse(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function importWeatherHistoryRows(rows) {
  for (const row of rows) {
    if (!row.beach_name || !row.forecast_date) continue;
    await WeatherRepository.cache({
      beach_name: row.beach_name,
      forecast_date: row.forecast_date,
      best_wind_kn: toNumberOrNull(row.best_wind_kn),
      best_wind_dir: toNumberOrNull(row.best_wind_dir),
      best_time: row.best_time ?? null,
      wave_height_m: toNumberOrNull(row.wave_height_m),
      temperature_c: toNumberOrNull(row.temperature_c),
      forecast_json: safeJsonParse(row.forecast_json),
    });
  }
  return rows.length;
}

async function importTideReadingsRows(rows) {
  const mapped = rows
    .filter((r) => r.station_id && r.reading_time)
    .map((r) => ({
      station_id: r.station_id,
      station_name: r.station_name ?? null,
      reading_time: r.reading_time,
      value_m: toNumberOrNull(r.value_m),
    }));
  await TideRepository.insertReadingsBatch(mapped);
  return mapped.length;
}

async function importTidePredictionsRows(rows) {
  const mapped = rows
    .filter((r) => r.station_id && r.prediction_time)
    .map((r) => ({
      station_id: r.station_id,
      prediction_time: r.prediction_time,
      value_m: toNumberOrNull(r.value_m),
      tide_type: r.tide_type ?? null,
      forecast_date: r.forecast_date ?? null,
    }));
  await TideRepository.insertPredictionsBatch(mapped);
  return mapped.length;
}

// Shared UI for the three small, fully-in-memory CSV imports (weather
// history, tide readings, tide predictions) — picks a file, parses it in
// one shot with papaparse, hands the rows to `onImport`, and shows the
// resulting row count.
function SimpleCsvImportSection({ title, icon, hint, buttonLabel, onImport }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importedCount, setImportedCount] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  async function pick() {
    try {
      setErrorMsg('');
      setImportedCount(null);
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
    } catch (e) {
      setErrorMsg(e.message);
    }
  }

  async function runImport() {
    if (!file) return;
    setBusy(true);
    setErrorMsg('');
    setImportedCount(null);
    try {
      const csvText = await FileSystem.readAsStringAsync(file.uri);
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      if (parsed.errors && parsed.errors.length > 0) {
        throw new Error(parsed.errors[0].message);
      }
      const count = await onImport(parsed.data);
      setImportedCount(count);
    } catch (e) {
      setErrorMsg(e.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View>
      <Text style={[styles.sectionLabel, { marginTop: 20 }]}>{icon} {title}</Text>
      <TouchableOpacity activeOpacity={0.7}
        style={[styles.dropZone, file && styles.dropZoneActive]}
        onPress={pick}
        disabled={busy}
        accessibilityLabel={`Tap to select ${title} CSV file`}
      >
        <Text style={styles.dropIcon}>{icon}</Text>
        <Text style={styles.dropTitle}>Tap to select CSV file</Text>
        <Text style={styles.dropSub}>{hint}</Text>
      </TouchableOpacity>

      {file && (
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewLabel}>📋 File Selected</Text>
          <Text style={styles.previewName}>{file.name}</Text>
          <Text style={styles.previewSize}>{file.size ? (file.size / 1024).toFixed(1) + ' KB' : '—'}</Text>
        </SharedCard>
      )}

      {file && importedCount == null && (
        <TouchableOpacity activeOpacity={0.7} style={[styles.importBtn, busy && styles.importBtnDisabled]} onPress={runImport} disabled={busy}>
          {busy && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
          <Text style={styles.importBtnText}>{busy ? 'Importing...' : buttonLabel}</Text>
        </TouchableOpacity>
      )}

      {!!errorMsg && <Text style={styles.errorText}>⚠️ {errorMsg}</Text>}

      {importedCount != null && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>✅</Text>
            <Text style={[styles.resultTitle, { color: SAFE }]}>
              {importedCount.toLocaleString()} row{importedCount === 1 ? '' : 's'} imported
            </Text>
          </View>
        </SharedCard>
      )}
    </View>
  );
}

export default function ImportDataScreen({ navigation }) {
  const [missingWeatherCount, setMissingWeatherCount] = useState(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState({ completed: 0, total: 0 });
  const [backfillResult, setBackfillResult] = useState(null);
  const [backfillError, setBackfillError] = useState('');

  useEffect(() => {
    WeatherBackfillService.countMissing().then(setMissingWeatherCount).catch(() => {});
  }, []);

  const [tier, setTier] = useState('free');
  const [indexStatus, setIndexStatus] = useState(null); // { indexed, total, lastIndexedAt, available }
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState({ completed: 0, total: 0 });
  const [indexError, setIndexError] = useState('');

  useEffect(() => {
    TierService.getCachedTier().then(setTier);
    EmbeddingService.getIndexStatus().then(setIndexStatus).catch(() => {});
  }, []);

  async function runIndexAllSessions() {
    setIndexing(true);
    setIndexError('');
    setIndexProgress({ completed: 0, total: 0 });
    try {
      await EmbeddingService.embedAllSessions((completed, total) => setIndexProgress({ completed, total }));
      setIndexStatus(await EmbeddingService.getIndexStatus());
    } catch (e) {
      setIndexError(e.message || 'Indexing failed');
    } finally {
      setIndexing(false);
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

  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [totalRows, setTotalRows] = useState(0);
  const [processedRows, setProcessedRows] = useState(0);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [done, setDone] = useState(false);

  const [tpFile, setTpFile] = useState(null);
  const [tpImporting, setTpImporting] = useState(false);
  const [tpTotalRows, setTpTotalRows] = useState(0);
  const [tpImportedRows, setTpImportedRows] = useState(0);
  const [tpErrorMsg, setTpErrorMsg] = useState('');
  const [tpDone, setTpDone] = useState(false);

  async function pickTrackpointsFile() {
    try {
      setTpErrorMsg('');
      setTpDone(false);
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'public.comma-separated-values-text', '*/*'],
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets || !picked.assets[0]) return;
      const asset = picked.assets[0];
      if (!asset.name.toLowerCase().endsWith('.csv')) {
        setTpErrorMsg('Please select a .csv file');
        return;
      }
      setTpFile(asset);
      setTpTotalRows(0);
      setTpImportedRows(0);
    } catch (e) {
      setTpErrorMsg(e.message);
    }
  }

  function confirmStartTrackpointsImport() {
    if (!tpFile) return;
    const sizeMb = (tpFile.size / (1024 * 1024)).toFixed(0);
    Alert.alert(
      'Import GPS Trackpoints',
      `${sizeMb}MB file, takes 5-10 minutes, keep app open.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Import', onPress: startTrackpointsImport },
      ]
    );
  }

  async function startTrackpointsImport() {
    if (!tpFile) return;
    setTpErrorMsg('');
    setTpDone(false);
    setTpImporting(true);
    setTpImportedRows(0);

    try {
      const totalRows = await countCsvDataRows(tpFile.uri, tpFile.size);
      setTpTotalRows(totalRows);

      const imported = await importTrackpointsCsv(tpFile, (count) => setTpImportedRows(count));

      setTpImportedRows(imported);
      setTpImporting(false);
      setTpDone(true);
    } catch (e) {
      setTpErrorMsg(e.message || 'Trackpoint import failed');
      setTpImporting(false);
    }
  }

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

      const [equipmentCache, gearComboCache] = await Promise.all([
        EquipmentRepository.getAll(null, { includeInactive: true }),
        EquipmentRepository.getGearCombos(),
      ]);

      let imported = 0;
      let skipped = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const existing = await SessionRepository.getById(row.session_id);
        if (existing) {
          skipped += 1;
        } else {
          const session = await mapRowToSession(row, equipmentCache, gearComboCache);
          await SessionRepository.insert(session);
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
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container} style={styles.scrollBg}>
      <Header title="📥 Import Historical Data" />

      <View style={styles.hero}>
        <Text style={styles.heroIcon}>🗄️</Text>
        <Text style={styles.heroTitle}>Import Historical Data</Text>
        <Text style={styles.heroSub}>CSV export from Oracle PostgreSQL</Text>
      </View>

      <Text style={styles.sectionLabel}>🧠 Generate AI Embeddings</Text>
      {canAccess('FULL_ANALYSIS', tier) ? (
        <>
          <SharedCard style={styles.previewCard}>
            {!indexStatus ? (
              <Text style={styles.previewName}>Checking index status…</Text>
            ) : !indexStatus.available ? (
              <Text style={styles.previewName}>Semantic search isn't available on this build.</Text>
            ) : (
              <>
                <Text style={styles.previewName}>
                  {indexStatus.indexed} of {indexStatus.total} sessions indexed
                </Text>
                {indexStatus.lastIndexedAt && (
                  <Text style={styles.previewSize}>Last indexed: {indexStatus.lastIndexedAt}</Text>
                )}
                <Text style={styles.previewSize}>Improves AI answer quality for Premium users</Text>
              </>
            )}
          </SharedCard>

          {!indexing && indexStatus?.available && indexStatus.indexed < indexStatus.total && (
            <TouchableOpacity style={styles.importBtn} onPress={runIndexAllSessions}>
              <Text style={styles.importBtnText}>🧠 Index All Sessions</Text>
            </TouchableOpacity>
          )}

          {indexing && (
            <SharedCard style={styles.progressCard}>
              <Text style={styles.progressLabel}>Generating embeddings…</Text>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${indexProgress.total ? Math.round((indexProgress.completed / indexProgress.total) * 100) : 0}%` },
                  ]}
                />
              </View>
              <Text style={styles.progressCount}>
                {indexProgress.completed} / {indexProgress.total} sessions
              </Text>
            </SharedCard>
          )}

          {!!indexError && <Text style={styles.errorText}>⚠️ {indexError}</Text>}
        </>
      ) : (
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewName}>Upgrade to Premium to enable AI-powered semantic search</Text>
        </SharedCard>
      )}

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

      <Text style={styles.sectionLabel}>📁 Select CSV File</Text>
      <TouchableOpacity activeOpacity={0.7}
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
        <TouchableOpacity activeOpacity={0.7} style={[styles.importBtn, busy && styles.importBtnDisabled]} onPress={startImport} disabled={busy}>
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

            <TouchableOpacity activeOpacity={0.7}
              style={styles.viewSessionsBtn}
              onPress={() => navigation.navigate('MainTabs', { screen: 'Sessions' })}
            >
              <Text style={styles.viewSessionsBtnText}>📅 View in Sessions</Text>
            </TouchableOpacity>
          </View>
        </SharedCard>
      )}

      <Text style={[styles.sectionLabel, { marginTop: 20 }]}>📍 GPS Trackpoints</Text>
      <TouchableOpacity activeOpacity={0.7}
        style={[styles.dropZone, tpFile && styles.dropZoneActive]}
        onPress={pickTrackpointsFile}
        disabled={tpImporting}
        accessibilityLabel="Tap to select trackpoints CSV file"
      >
        <Text style={styles.dropIcon}>🛰️</Text>
        <Text style={styles.dropTitle}>Tap to select trackpoints CSV file</Text>
        <Text style={styles.dropSub}>session_id, timestamp, lat, lon, speed, course, hr, elevation</Text>
      </TouchableOpacity>

      {tpFile && (
        <SharedCard style={styles.previewCard}>
          <Text style={styles.previewLabel}>📋 File Selected</Text>
          <Text style={styles.previewName}>{tpFile.name}</Text>
          <Text style={styles.previewSize}>
            {tpFile.size ? (tpFile.size / (1024 * 1024)).toFixed(1) + ' MB' : '—'}
          </Text>
        </SharedCard>
      )}

      {tpFile && !tpDone && (
        <TouchableOpacity activeOpacity={0.7}
          style={[styles.importBtn, tpImporting && styles.importBtnDisabled]}
          onPress={confirmStartTrackpointsImport}
          disabled={tpImporting}
        >
          {tpImporting && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
          <Text style={styles.importBtnText}>
            {tpImporting ? 'Importing...' : '📥 Import GPS Trackpoints'}
          </Text>
        </TouchableOpacity>
      )}

      {!!tpErrorMsg && <Text style={styles.errorText}>⚠️ {tpErrorMsg}</Text>}

      {(tpImporting || tpDone) && tpTotalRows > 0 && (
        <SharedCard style={styles.progressCard}>
          <Text style={styles.progressLabel}>
            {tpImportedRows.toLocaleString()} / {tpTotalRows.toLocaleString()} trackpoints
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round((tpImportedRows / tpTotalRows) * 100)}%` }]} />
          </View>
        </SharedCard>
      )}

      {tpDone && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>✅</Text>
            <Text style={[styles.resultTitle, { color: SAFE }]}>
              {tpImportedRows.toLocaleString()} trackpoints imported
            </Text>
            <Text style={styles.resultSub}>GPS maps now available</Text>
          </View>
        </SharedCard>
      )}

      <SimpleCsvImportSection
        title="Weather History"
        icon="🌦️"
        hint="beach_name, forecast_date, best_wind_kn, best_wind_dir, best_time, wave_height_m, temperature_c, forecast_json"
        buttonLabel="📥 Import Weather History"
        onImport={importWeatherHistoryRows}
      />

      <SimpleCsvImportSection
        title="Tide Readings"
        icon="🌊"
        hint="station_id, station_name, reading_time, value_m"
        buttonLabel="📥 Import Tide Readings"
        onImport={importTideReadingsRows}
      />

      <SimpleCsvImportSection
        title="Tide Predictions"
        icon="📈"
        hint="station_id, prediction_time, value_m, tide_type, forecast_date"
        buttonLabel="📥 Import Tide Predictions"
        onImport={importTidePredictionsRows}
      />
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

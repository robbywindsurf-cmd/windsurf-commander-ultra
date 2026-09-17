import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Papa from 'papaparse';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { SessionRepository, EquipmentRepository, TrackpointRepository, WeatherRepository, TideRepository, WeightRepository, EmbeddingService, TierService, canAccess } from '@commandersuite/core';

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
// Matches on (type, name, brand) only — not size. Size varies row-to-row
// in the historical CSV (present on some session rows for a board, blank
// on others), and matching on it too meant the same physical board spawned
// a fresh "duplicate" equipment row every time size differed, including
// every time it was simply missing. If an existing match is missing size
// and this row has one, fill it in rather than leaving it incomplete.
async function findOrCreateEquipment(cache, type, name, brand, size) {
  if (!name) return null;
  const existing = cache.find(
    (e) => e.type === type && e.name === name && (e.brand || null) === (brand || null)
  );
  if (existing) {
    if (!existing.size && size) {
      // update() replaces the whole row, not a partial patch — merge onto
      // the existing record rather than passing { size } alone, or every
      // other column (name/brand/year/notes/volume_l/...) gets wiped.
      await EquipmentRepository.update(existing.id, { ...existing, size });
      existing.size = size;
    }
    return existing.id;
  }

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

// Returns { count, minDate, maxDate } rather than a plain row count, so the
// UI can show "58 weight readings imported (2017-2026)" instead of a bare
// number — the date range is what actually tells you whether the import
// covered the years you expected.
async function importWeightLogRows(rows) {
  const mapped = rows
    .filter((r) => r.recorded_date && toNumberOrNull(r.weight_kg) != null)
    .map((r) => ({
      logged_at: r.recorded_date,
      weight_kg: toNumberOrNull(r.weight_kg),
      notes: r.notes || null,
    }));
  const count = await WeightRepository.insertBatch(mapped);

  const dates = mapped.map((r) => r.logged_at).sort();
  return {
    count,
    minDate: dates[0]?.slice(0, 4) ?? null,
    maxDate: dates[dates.length - 1]?.slice(0, 4) ?? null,
  };
}

function parseCsvBool(value) {
  const v = (value ?? '').toString().trim().toLowerCase();
  return v === 'true' || v === 't' || v === '1' || v === 'yes';
}

// Wipes gear_combos + equipment and rebuilds equipment (boards/sails/fins)
// from the Oracle export. gear_combos is cleared here too, not just in
// importGearCombosRows, since its board_id/sail_id/fin_id would otherwise
// dangle once the equipment rows they point at are deleted.
//
// Column notes (mapped onto the real equipment schema, not 1:1 onto the
// CSV headers — there's no `length`/`box` column, so those fold into
// `notes` rather than being invented as new, otherwise-unused columns):
//  - size: boards store it as volume_l (numeric, litres — matches
//    GarageScreen's "120L" display); sails/fins keep it in the generic
//    `size` text column ("7.5", "28").
//  - design: for fins this *is* fin_type (the column's exact purpose —
//    "Wave"/"Freeride"/etc); for sails there's no equivalent column, so it
//    goes into notes instead.
//  - box (fin box type, e.g. "Powerbox") and board length have no column
//    of their own — appended to notes.
async function importEquipmentRows(rows) {
  await EquipmentRepository.deleteAllGearCombos();
  await EquipmentRepository.deleteAllEquipment();

  const counts = { board: 0, sail: 0, fin: 0 };

  for (const row of rows) {
    const type = (row.type || '').trim().toLowerCase();
    if (!['board', 'sail', 'fin'].includes(type) || !row.name) continue;

    const lengthCm = toNumberOrNull(row.length);
    const widthCm = toNumberOrNull(row.width);
    const year = toNumberOrNull(row.year);
    const sizeNum = toNumberOrNull(row.size);

    const notesParts = [];
    let finType = null;
    if (type === 'fin') {
      finType = row.design || null;
      if (row.box) notesParts.push(`Box: ${row.box}`);
    } else if (type === 'sail' && row.design) {
      notesParts.push(row.design);
    }
    if (type === 'board' && lengthCm != null) {
      notesParts.push(`Length: ${lengthCm}cm`);
    }

    await EquipmentRepository.insert({
      type,
      name: row.name,
      brand: row.brand || null,
      size: type === 'board' ? null : (row.size || null),
      year: type === 'board' ? year : null,
      notes: notesParts.length ? notesParts.join(' · ') : null,
      volume_l: type === 'board' ? sizeNum : null,
      width_cm: type === 'board' ? widthCm : null,
      fin_type: finType,
      active: parseCsvBool(row.active) ? 1 : 0,
    });
    counts[type] += 1;
  }

  return counts;
}

// "Fox 120L" (combos.csv's board column) → { name: "Fox", volume: 120 }.
function parseComboBoardField(value) {
  const trimmed = (value || '').trim();
  const m = /^(.*?)\s+(\d+(?:\.\d+)?)\s*L$/i.exec(trimmed);
  if (!m) return { name: trimmed, volume: null };
  return { name: m[1].trim(), volume: Number(m[2]) };
}

// Resolves each row's board/sail names (from the already-imported
// equipment) into gear_combos rows. Must run after importEquipmentRows —
// looks up the *current* equipment table rather than trusting ids, since
// combos.csv only carries names/sizes, not equipment ids. No fin column in
// this CSV, so fin_id is always left null.
async function importGearCombosRows(rows) {
  await EquipmentRepository.deleteAllGearCombos();

  const [boards, sails] = await Promise.all([
    EquipmentRepository.getAll('board', { includeInactive: true }),
    EquipmentRepository.getAll('sail', { includeInactive: true }),
  ]);

  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const { name: boardName, volume } = parseComboBoardField(row.board);
    const board = boards.find(
      (b) => b.name === boardName && (volume == null || b.volume_l == null || Math.abs(b.volume_l - volume) < 0.5)
    );
    const sailName = (row.sail || '').trim();
    const sail = sails.find(
      (s) => s.name === sailName && (!row.sail_size || String(s.size) === String(row.sail_size).trim())
    );

    if (!board || !sail) {
      skipped += 1;
      continue;
    }

    const conditions = (row.conditions || '')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .join(' | ');

    const name = [
      [board.brand, board.name].filter(Boolean).join(' '),
      [sail.brand, sail.name, row.sail_size ? row.sail_size + 'm²' : null].filter(Boolean).join(' '),
    ].join(' / ');

    await EquipmentRepository.insertGearCombo({
      name,
      board_id: board.id,
      sail_id: sail.id,
      fin_id: null,
      notes: row.notes || null,
      category: conditions || null,
      wind_min_kn: toNumberOrNull(row.min_wind),
      wind_max_kn: toNumberOrNull(row.max_wind),
      wave_min_m: toNumberOrNull(row.min_waves),
      wave_max_m: toNumberOrNull(row.max_waves),
    });
    imported += 1;
  }

  // Stale from before this reimport (different gear_combo_id values, and
  // possibly a different text shape now that brand is included) — RAG's
  // semantic search won't reflect the new equipment until these are
  // regenerated.
  await EmbeddingService.clearAll();
  await EmbeddingService.embedAllSessions();

  return { imported, skipped };
}

// Shared UI for the three small, fully-in-memory CSV imports (weather
// history, tide readings, tide predictions) — picks a file, parses it in
// one shot with papaparse, hands the rows to `onImport`, and shows the
// resulting row count.
function SimpleCsvImportSection({ title, icon, hint, buttonLabel, onImport, formatResult }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  async function pick() {
    try {
      setErrorMsg('');
      setResult(null);
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
    setResult(null);
    try {
      const csvText = await FileSystem.readAsStringAsync(file.uri);
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      if (parsed.errors && parsed.errors.length > 0) {
        throw new Error(parsed.errors[0].message);
      }
      setResult(await onImport(parsed.data));
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

      {file && result == null && (
        <TouchableOpacity activeOpacity={0.7} style={[styles.importBtn, busy && styles.importBtnDisabled]} onPress={runImport} disabled={busy}>
          {busy && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
          <Text style={styles.importBtnText}>{busy ? 'Importing...' : buttonLabel}</Text>
        </TouchableOpacity>
      )}

      {!!errorMsg && <Text style={styles.errorText}>⚠️ {errorMsg}</Text>}

      {result != null && (
        <SharedCard style={styles.resultCard}>
          <View style={styles.resultCenter}>
            <Text style={styles.resultIcon}>✅</Text>
            <Text style={[styles.resultTitle, { color: SAFE }]}>
              {formatResult ? formatResult(result) : `${result.toLocaleString()} row${result === 1 ? '' : 's'} imported`}
            </Text>
          </View>
        </SharedCard>
      )}
    </View>
  );
}

export default function ImportDataScreen({ navigation }) {
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
        let existing = await SessionRepository.getById(row.session_id);

        // A session first brought in via FIT import carries an id FITImporter
        // generated itself ('fit_<timestamp>') — unrelated to whatever
        // session_id this CSV's own export happened to assign the same real
        // session, so the lookup above never matches it. Fall back to same
        // date + closest peak speed (unlikely to collide for two different
        // sessions on the same day) to find it under its real id instead.
        if (!existing && row.session_date && row.peak_speed_knots !== undefined) {
          const sameDay = await SessionRepository.getByDate(row.session_date);
          const targetSpeed = toNumberOrNull(row.peak_speed_knots);
          if (targetSpeed != null) {
            let best = null;
            let bestDiff = Infinity;
            for (const candidate of sameDay) {
              if (candidate.max_speed_kn == null) continue;
              const diff = Math.abs(candidate.max_speed_kn - targetSpeed);
              if (diff < bestDiff) { bestDiff = diff; best = candidate; }
            }
            if (best && bestDiff <= 0.15) existing = best;
          }
        }

        if (existing) {
          // Sessions first brought in via FIT import always land with
          // gear_combo_id null (FIT files carry no board/sail data) — a
          // later CSV import that does have gear columns is the only way
          // to backfill it, so update gear here rather than skipping the
          // row outright just because the session itself already exists.
          if (!existing.gear_combo_id) {
            const session = await mapRowToSession(row, equipmentCache, gearComboCache);
            if (session.gear_combo_id) {
              await SessionRepository.setGearCombo(existing.session_id, session.gear_combo_id);
            }
          }
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

      <SimpleCsvImportSection
        title="Weight Data"
        icon="⚖️"
        hint="recorded_date, weight_kg, notes"
        buttonLabel="📥 Import Weight Data"
        onImport={importWeightLogRows}
        formatResult={({ count, minDate, maxDate }) =>
          `${count.toLocaleString()} weight reading${count === 1 ? '' : 's'} imported${
            minDate && maxDate ? ` (${minDate}-${maxDate})` : ''
          }`
        }
      />

      <SimpleCsvImportSection
        title="Equipment (clears existing Garage first)"
        icon="🎒"
        hint="type, brand, name, size, length, width, year, active, design, box"
        buttonLabel="📥 Import Equipment from CSV"
        onImport={async (rows) => {
          const counts = await importEquipmentRows(rows);
          console.log('[Import] Boards:', counts.board);
          console.log('[Import] Sails:', counts.sail);
          console.log('[Import] Fins:', counts.fin);
          return counts;
        }}
        formatResult={(counts) =>
          `${counts.board} board${counts.board === 1 ? '' : 's'}, ${counts.sail} sail${counts.sail === 1 ? '' : 's'}, ${counts.fin} fin${counts.fin === 1 ? '' : 's'} imported`
        }
      />

      <SimpleCsvImportSection
        title="Gear Combos (import Equipment CSV first)"
        icon="🧩"
        hint="board, sail, sail_size, min_wind, max_wind, min_waves, max_waves, conditions, notes, active"
        buttonLabel="📥 Import Gear Combos from CSV"
        onImport={async (rows) => {
          const result = await importGearCombosRows(rows);
          console.log('[Import] Combos:', result.imported);
          return result;
        }}
        formatResult={({ imported, skipped }) =>
          `${imported} combo${imported === 1 ? '' : 's'} imported` + (skipped > 0 ? `, ${skipped} skipped (board/sail not found)` : '')
        }
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

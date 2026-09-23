// SessionCsvImporter.js
// The session-history CSV (session_id, date, times, speeds, board/sail/fin
// columns, rep_lat/rep_lon) is the primary source for gear — it carries
// everything a session needs except the GPS track. FIT files (see
// FITImporter.js) supply trackpoints and FIT-only summary fields (distance,
// heart rate, calories) the CSV doesn't have at all.
//
// A CSV row's own session_id comes from whatever system originally
// exported it and has no relation to a FIT-imported session's id (FITImporter
// generates its own 'fit_<timestamp>'). Rather than reconciling that by
// deleting and reinserting sessions (which was tried and lost distance/HR/
// calories, since the CSV can't supply what it never had), each row here
// is matched to its real existing session — by id, or by date + closest
// peak speed for one that came from FIT — and only the CSV's own columns
// are written onto it. A row with no existing match becomes a new,
// GPS-less session (e.g. history from before you started using this app).
//
// sessions has no board_name/sail_name/wind_speed columns of its own — gear
// lives via gear_combo_id -> gear_combos -> equipment (see schema.js), and
// wind/temperature already have a dedicated import path into weather_cache
// (ImportDataScreen's weather-history CSV), so those two CSV columns are
// read but not written here to avoid duplicating that data model.

import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Papa from 'papaparse';
import { SessionRepository, EquipmentRepository } from '@commandersuite/core';

const SPEED_MATCH_TOLERANCE_KN = 1.0;
// Date + speed alone isn't enough to identify a session — two real
// sessions on the same day (an AM and a PM session) can land within 1kn
// of each other's peak speed, which silently matched a CSV row onto the
// wrong one of the two. Start time must also be within this many minutes
// to accept a match. A real match should differ by minutes at most
// (export rounding) — 30 rather than a wider window, since a real AM/PM
// pair (11:19 vs 14:18, 179 minutes apart) fell inside anything looser.
const MAX_TIME_DIFF_MINUTES = 30;

// sessions.start_time isn't a consistent format across import sources —
// FIT-derived rows store bare "HH:MM", CSV-derived rows store a full
// "YYYY-MM-DDTHH:MM:SS". Pulls just the time-of-day out of either, as
// minutes since midnight.
function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const timePart = timeStr.includes('T') ? timeStr.split('T')[1] : timeStr;
  const match = timePart && timePart.match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

// The export CSV uses the literal string "Unknown" in board/sail/fin name
// and brand columns to mean "gear wasn't recorded for this session" — not
// an actual piece of kit called "Unknown". Treated as blank so it never
// creates a bogus equipment row or gets matched against real gear.
function realValue(value) {
  return value && value.trim().toLowerCase() !== 'unknown' ? value : null;
}

// Matches findOrCreateEquipment's own behaviour in ImportDataScreen.js —
// duplicated rather than imported from there, since the two screens make
// independent picks about what to do with an existing row.
//
// sessions_export.csv has no fin_brand column at all (only board_brand and
// sail_brand), so `brand` is always null for a fin lookup — matching on
// brand there would never find a real fin (which does have a brand from
// equipment.csv) and would create a duplicate, null-brand fin row on every
// single import. Brand is only compared when the caller actually supplied
// one.
async function findOrCreateEquipment(cache, type, name, brand, size) {
  if (!name) return null;
  const existing = cache.find(
    (e) => e.type === type && e.name === name && (brand == null || (e.brand || null) === brand)
  );
  if (existing) {
    if (!existing.size && size) {
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

async function findOrCreateGearCombo(cache, boardId, sailId, finId, name) {
  if (!boardId && !sailId && !finId) return null;
  const existing = cache.find(
    (c) => (c.board_id || null) === (boardId || null) && (c.sail_id || null) === (sailId || null) && (c.fin_id || null) === (finId || null)
  );
  if (existing) return existing.id;

  const result = await EquipmentRepository.insertGearCombo({ name, board_id: boardId, sail_id: sailId, fin_id: finId, source: 'auto' });
  const id = result.lastInsertRowId;
  cache.push({ id, board_id: boardId, sail_id: sailId, fin_id: finId, name });
  return id;
}

// Same day + peak speed within tolerance is treated as the same real
// session — two different sessions on the same day landing within 1kn of
// each other's top speed is unlikely enough to accept the risk.
async function findExistingSession(row) {
  const byId = row.session_id ? await SessionRepository.getById(row.session_id) : null;
  if (byId) return byId;

  if (!row.session_date) return null;
  const sameDay = await SessionRepository.getByDate(row.session_date);
  if (!sameDay.length) return null;

  const targetSpeed = toNumberOrNull(row.peak_speed_knots);
  if (targetSpeed == null) return sameDay.length === 1 ? sameDay[0] : null;

  const rowMinutes = timeToMinutes(row.start_time);
  let best = null;
  let bestDiff = Infinity;
  for (const candidate of sameDay) {
    if (candidate.max_speed_kn == null) continue;
    const candidateMinutes = timeToMinutes(candidate.start_time);
    if (rowMinutes != null && candidateMinutes != null &&
        Math.abs(rowMinutes - candidateMinutes) > MAX_TIME_DIFF_MINUTES) continue;
    const diff = Math.abs(candidate.max_speed_kn - targetSpeed);
    if (diff < bestDiff) { bestDiff = diff; best = candidate; }
  }
  return best && bestDiff <= SPEED_MATCH_TOLERANCE_KN ? best : null;
}

async function upsertRow(row, equipmentCache, gearComboCache) {
  const boardName = realValue(row.board_name);
  const sailName = realValue(row.sail_name);
  const finName = realValue(row.fin_name);
  const boardId = await findOrCreateEquipment(equipmentCache, 'board', boardName, realValue(row.board_brand), row.board_size);
  const sailId = await findOrCreateEquipment(equipmentCache, 'sail', sailName, realValue(row.sail_brand), row.sail_size);
  const finId = await findOrCreateEquipment(equipmentCache, 'fin', finName, null, row.fin_size);
  const gearComboName = [boardName, sailName].filter(Boolean).join(' / ') || null;
  const gearComboId = await findOrCreateGearCombo(gearComboCache, boardId, sailId, finId, gearComboName);

  const durationMinutes = toNumberOrNull(row.duration_minutes);
  const durationS = durationMinutes != null ? Math.round(durationMinutes * 60) : null;
  const maxSpeedKn = toNumberOrNull(row.peak_speed_knots);
  const avgSpeedKn = toNumberOrNull(row.avg_speed_knots);
  const lat = toNumberOrNull(row.rep_lat);
  const lon = toNumberOrNull(row.rep_lon);

  const existing = await findExistingSession(row);

  if (existing) {
    // Only the fields this CSV actually carries — distance_m, max_hr,
    // avg_hr, calories stay exactly as FIT import left them.
    await SessionRepository.updateFields(existing.session_id, {
      start_time: row.start_time || existing.start_time,
      end_time: row.end_time || existing.end_time,
      duration_s: durationS ?? existing.duration_s,
      max_speed_kn: maxSpeedKn ?? existing.max_speed_kn,
      avg_speed_kn: avgSpeedKn ?? existing.avg_speed_kn,
      sport: row.session_type || existing.sport,
      gear_combo_id: gearComboId ?? existing.gear_combo_id,
      notes: row.session_name || existing.notes,
      lat: lat ?? existing.lat,
      lon: lon ?? existing.lon,
    });
    return 'updated';
  }

  await SessionRepository.insert({
    session_id: row.session_id,
    date: row.session_date || null,
    start_time: row.start_time || null,
    end_time: row.end_time || null,
    duration_s: durationS,
    distance_m: null,
    max_speed_kn: maxSpeedKn,
    avg_speed_kn: avgSpeedKn,
    max_hr: null,
    avg_hr: null,
    calories: null,
    sport: row.session_type || 'windsurf',
    beach_id: null,
    gear_combo_id: gearComboId,
    notes: row.session_name || null,
    lat,
    lon,
  });
  return 'created';
}

export async function pickSessionsCsv() {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['text/csv', 'text/comma-separated-values', 'public.comma-separated-values-text', '*/*'],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  if (!asset.name.toLowerCase().endsWith('.csv')) {
    throw new Error('Please select a .csv file');
  }
  return asset;
}

// Safe to run repeatedly on the same file — each row is matched to its
// real session (by id, or by date+speed for a FIT-originated one) and
// merged in, never a blind replace, so re-running never loses distance/HR/
// calories a FIT import already wrote.
export async function importSessionsCsv(asset, { onProgress } = {}) {
  onProgress?.('Reading file…', 0.05);
  const csvText = await FileSystem.readAsStringAsync(asset.uri);
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  if (parsed.errors?.length) throw new Error(parsed.errors[0].message);

  const rows = parsed.data.filter((r) => r.session_id);
  if (!rows.length) throw new Error('No session rows found in this CSV.');

  const [equipmentCache, gearComboCache] = await Promise.all([
    EquipmentRepository.getAll(null, { includeInactive: true }),
    EquipmentRepository.getGearCombos(),
  ]);

  let created = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const outcome = await upsertRow(rows[i], equipmentCache, gearComboCache);
    if (outcome === 'created') created += 1; else updated += 1;
    onProgress?.(`Importing sessions… ${i + 1}/${rows.length}`, 0.05 + 0.9 * ((i + 1) / rows.length));
  }

  onProgress?.('Complete', 1);
  return { created, updated, total: rows.length };
}

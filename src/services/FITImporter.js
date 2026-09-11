// FITImporter.js
// Local FIT file import — no Oracle, no remote parser. Reads the file,
// parses it on-device with fit-file-parser, and writes session + trackpoint
// rows straight into commander-core's SQLite db.
// Reference: production app's UploadScreen.js posted the same shape of data
// to a remote Python parser + Oracle webhook; this replaces both with local
// parsing + SessionRepository.

import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import FitParser from 'fit-file-parser';
import { SessionRepository, getDb } from '@commandersuite/core';

const MPS_TO_KN = 1.94384;
// fit-file-parser already converts position_lat/position_long to real
// degrees (despite the Garmin profile listing them as raw "semicircles") —
// no extra conversion needed here. An earlier version of this file applied
// one anyway, shrinking every coordinate by ~180/2^31 (e.g. 50.38° became
// 0.0000042°), which is why old imports show a blank map — see
// repairLegacyTrackpoints() below.
const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

function isoDate(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function isoTime(date) {
  return date ? date.toISOString().slice(11, 16) : null;
}

function toKn(mps) {
  return mps != null ? Math.round(mps * MPS_TO_KN * 10) / 10 : null;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Some devices (this one included) write GPS position but no speed field at
// all — neither per-record nor at the session summary. Where a record has
// no speed of its own, derive one from the surrounding points' GPS position
// and elapsed time (a centered difference), so the map and session summary
// still have real numbers instead of every fallback bottoming out at null.
function fillMissingSpeeds(records) {
  return records.map((r, i) => {
    if (r.speed != null || r.enhanced_speed != null) return r;
    if (r.position_lat == null || r.position_long == null) return r;

    const prev = records[i - 1];
    const next = records[i + 1];
    const before = prev?.position_lat != null && prev.position_long != null ? prev : null;
    const after = next?.position_lat != null && next.position_long != null ? next : null;
    if (!before || !after || !before.timestamp || !after.timestamp) return r;

    const distM = haversineMeters(
      before.position_lat, before.position_long,
      after.position_lat, after.position_long
    );
    const dtS = (after.timestamp.getTime() - before.timestamp.getTime()) / 1000;
    if (!dtS) return r;

    return { ...r, speed: distM / dtS };
  });
}

// Some devices only populate enhanced_max_speed/enhanced_avg_speed at the
// session level (or omit both entirely), so fall back through: enhanced
// session field -> standard session field -> computed from trackpoints.
function resolveSpeed(session, records, kind) {
  const enhancedField = kind === 'max' ? 'enhanced_max_speed' : 'enhanced_avg_speed';
  const standardField = kind === 'max' ? 'max_speed' : 'avg_speed';

  if (session[enhancedField] != null) return session[enhancedField];
  if (session[standardField] != null) return session[standardField];

  const speeds = records
    .map((r) => r.enhanced_speed ?? r.speed)
    .filter((v) => v != null);
  if (!speeds.length) return null;

  return kind === 'max'
    ? Math.max(...speeds)
    : speeds.reduce((a, b) => a + b, 0) / speeds.length;
}

// Deterministic id for a FIT file's session — never falls back to Date.now(),
// which would give the same file a different id (and a duplicate row) on
// every import if start_time were ever missing.
function resolveSessionId(session, records, asset) {
  const startTime = session.start_time || records[0]?.timestamp;
  if (startTime) return 'fit_' + startTime.getTime();
  return 'fit_' + `${asset.name}_${asset.size || 0}`;
}

async function insertTrackpoints(db, sessionId, records) {
  // Re-import of the same file replaces trackpoints rather than duplicating them.
  await db.runAsync('DELETE FROM trackpoints WHERE session_id = ?', [sessionId]);
  for (const r of records) {
    if (!r.timestamp) continue;
    await db.runAsync(
      `INSERT INTO trackpoints (session_id, timestamp, lat, lon, speed_ms, course, hr, elevation)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        sessionId,
        r.timestamp.toISOString(),
        r.position_lat ?? null,
        r.position_long ?? null,
        r.enhanced_speed ?? r.speed ?? null,
        null,
        r.heart_rate ?? null,
        r.altitude ?? null,
      ]
    );
  }
}

// One-time repair for rows written by the earlier buggy import (see the
// SEMICIRCLE_TO_DEG note above): a lat/lon that's still within ~1° of zero
// is unmistakably one that was wrongly shrunk by 180/2^31, since no real
// windsurfing session happens at the equator/prime meridian. Reverses the
// bad multiply, then recomputes that session's stored speed from the fixed
// GPS track (these rows also predate the GPS-derived-speed fallback).
// Safe to call on every app start — already-correct rows are left alone.
export async function repairLegacyTrackpoints() {
  const db = await getDb();
  const bad = await db.getAllAsync(
    "SELECT DISTINCT session_id FROM trackpoints WHERE ABS(lat) < 1 AND ABS(lon) < 1 AND lat != 0"
  );
  if (!bad.length) return { repaired: 0 };

  for (const { session_id } of bad) {
    const rows = await db.getAllAsync(
      'SELECT id, lat, lon, timestamp FROM trackpoints WHERE session_id = ? ORDER BY timestamp ASC',
      [session_id]
    );
    const fixed = rows.map((r) => ({
      ...r,
      lat: r.lat / SEMICIRCLE_TO_DEG,
      lon: r.lon / SEMICIRCLE_TO_DEG,
    }));

    for (const r of fixed) {
      await db.runAsync('UPDATE trackpoints SET lat = ?, lon = ? WHERE id = ?', [r.lat, r.lon, r.id]);
    }

    const speeds = [];
    for (let i = 1; i < fixed.length - 1; i++) {
      const before = fixed[i - 1];
      const after = fixed[i + 1];
      const distM = haversineMeters(before.lat, before.lon, after.lat, after.lon);
      const dtS = (new Date(after.timestamp) - new Date(before.timestamp)) / 1000;
      if (dtS > 0) {
        const speedMps = distM / dtS;
        speeds.push(speedMps);
        await db.runAsync('UPDATE trackpoints SET speed_ms = ? WHERE id = ?', [speedMps, fixed[i].id]);
      }
    }

    if (speeds.length) {
      await db.runAsync(
        'UPDATE sessions SET max_speed_kn = ?, avg_speed_kn = ? WHERE session_id = ?',
        [toKn(Math.max(...speeds)), toKn(speeds.reduce((a, b) => a + b, 0) / speeds.length), session_id]
      );
    }
  }

  return { repaired: bad.length };
}

// Opens the document picker restricted to .fit files. Returns the picked
// asset ({ uri, name, size }) or null if the user cancelled.
export async function pickFitFile() {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  if (!asset.name.toLowerCase().endsWith('.fit')) {
    throw new Error('Please select a .fit file');
  }
  return asset;
}

// Parses a picked FIT asset and saves session + trackpoints locally.
// onProgress(status: string, pct: 0..1) reports import progress.
export async function importFitFile(asset, { onProgress } = {}) {
  onProgress?.('Reading file…', 0.1);
  const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
  const buffer = Buffer.from(base64, 'base64');

  onProgress?.('Parsing FIT data…', 0.3);
  const parser = new FitParser({
    mode: 'list',
    speedUnit: 'm/s',
    lengthUnit: 'm',
    elapsedRecordField: true,
  });
  const data = await parser.parseAsync(buffer);

  const session = data.sessions?.[0];
  if (!session) throw new Error('No session data found in FIT file.');

  const records = fillMissingSpeeds(data.records || []);
  const heartRates = records.map((r) => r.heart_rate).filter((v) => v != null);

  onProgress?.('Checking for duplicates…', 0.5);
  const sessionId = resolveSessionId(session, records, asset);
  const existing = await SessionRepository.getById(sessionId);
  if (existing) {
    onProgress?.('Already imported', 1);
    return { duplicate: true, sessionId };
  }

  const maxSpeedMps = resolveSpeed(session, records, 'max');
  const avgSpeedMps = resolveSpeed(session, records, 'avg');

  onProgress?.('Saving session…', 0.7);
  await SessionRepository.insert({
    session_id: sessionId,
    date: isoDate(session.start_time),
    start_time: isoTime(session.start_time),
    end_time: isoTime(session.timestamp),
    duration_s: session.total_elapsed_time ?? null,
    distance_m: session.total_distance ?? null,
    max_speed_kn: toKn(maxSpeedMps),
    avg_speed_kn: toKn(avgSpeedMps),
    max_hr: session.max_heart_rate ?? (heartRates.length ? Math.max(...heartRates) : null),
    avg_hr: session.avg_heart_rate
      ?? (heartRates.length ? Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length) : null),
    calories: session.total_calories ?? null,
    sport: session.sport || 'windsurf',
    beach_id: null,
    gear_combo_id: null,
    notes: null,
  });

  onProgress?.(`Saving ${records.length} trackpoints…`, 0.85);
  const db = await getDb();
  await insertTrackpoints(db, sessionId, records);

  onProgress?.('Complete', 1);

  return {
    duplicate: false,
    sessionId,
    session: {
      date: isoDate(session.start_time),
      durationMinutes: session.total_elapsed_time ? Math.round(session.total_elapsed_time / 60) : null,
      trackpoints: records.length,
      maxSpeedKn: toKn(maxSpeedMps),
      distanceKm: session.total_distance != null ? Math.round(session.total_distance / 100) / 10 : null,
    },
  };
}

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

// sessions.start_time isn't a consistent format across import sources —
// FIT-derived rows store bare "HH:MM" (isoTime() above), CSV-derived rows
// store a full "YYYY-MM-DDTHH:MM:SS". Pulls just the time-of-day out of
// either, as minutes since midnight.
function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const timePart = timeStr.includes('T') ? timeStr.split('T')[1] : timeStr;
  const match = timePart && timePart.match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

// Same-day session matching (below) previously used date + peak speed
// alone — two genuinely different sessions on the same day (an AM and a
// PM session) with similar top speeds would collide, silently matching
// the second FIT import onto the first session and discarding it as
// "already imported". Requiring start times to be close too (not just
// the date) is what actually distinguishes them. A real match between a
// FIT file and its own CSV row should differ by minutes at most (export
// rounding, not clock drift between different sessions) — 30 rather than
// the original 180 minutes, which a real AM/PM pair (11:19 vs 14:18, 179
// minutes apart) still fell inside.
const MAX_TIME_DIFF_MINUTES = 30;

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

// GPS watches used for windsurfing generally don't write a heading/course
// field into the FIT record at all (it's not something these devices
// track) — course-over-ground has to be derived from consecutive GPS
// positions instead, exactly like fillMissingSpeeds() above does for
// speed. Without this, every trackpoint's course stayed null, which
// silently zeroed out WindEstimator (needs course to find a tacking
// pattern) and ManoeuvreDetector (needs course changes to find tacks and
// gybes) for every FIT-imported session.
function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function fillMissingCourses(records) {
  return records.map((r, i) => {
    if (r.course != null || r.heading != null) return r;
    if (r.position_lat == null || r.position_long == null) return r;

    const prev = records[i - 1];
    if (!prev || prev.position_lat == null || prev.position_long == null) return r;
    if (prev.position_lat === r.position_lat && prev.position_long === r.position_long) return r;

    return { ...r, course: bearingDeg(prev.position_lat, prev.position_long, r.position_lat, r.position_long) };
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
        r.course ?? r.heading ?? null,
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

// Repair for sessions.distance_m lost to an earlier version of the CSV
// session import, which fully replaced session rows (including
// distance_m, which the CSV never carries) instead of merging in only the
// columns it actually has — see SessionCsvImporter.js. Recomputes it from
// this session's own stored GPS trackpoints (summed haversine distance
// between consecutive points) wherever it's missing but a track exists.
// Safe to call on every app start — sessions that already have a distance
// are left alone.
export async function repairMissingDistance() {
  const db = await getDb();
  const missing = await db.getAllAsync(`
    SELECT DISTINCT s.session_id
    FROM sessions s
    JOIN trackpoints t ON t.session_id = s.session_id
    WHERE s.distance_m IS NULL
  `);
  if (!missing.length) return { repaired: 0 };

  for (const { session_id } of missing) {
    const points = await db.getAllAsync(
      'SELECT lat, lon FROM trackpoints WHERE session_id = ? AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY timestamp ASC',
      [session_id]
    );
    if (points.length < 2) continue;

    let distanceM = 0;
    for (let i = 1; i < points.length; i++) {
      distanceM += haversineMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    await db.runAsync('UPDATE sessions SET distance_m = ? WHERE session_id = ?', [Math.round(distanceM), session_id]);
  }

  return { repaired: missing.length };
}

// Repair for trackpoints.course left null by every FIT import before the
// fillMissingCourses() fix above — these GPS watches never write a
// heading/course field, so course stayed null for every point of every
// FIT-imported session, silently zeroing out WindEstimator and
// ManoeuvreDetector (both need course to find a tacking/turning pattern)
// for sessions that do have a real GPS track. Recomputes it as the GPS
// bearing between consecutive points. Safe to call on every app start —
// sessions that already have course values are left alone.
// SessionsScreen calls repairMissingCourses() from load(), which
// useFocusEffect can re-trigger (e.g. re-focusing the tab) before a
// previous, still-running call has finished — two overlapping
// db.withTransactionAsync calls on the same connection throw "cannot
// start a transaction within a transaction" and abort load() entirely,
// which is what made the whole session list disappear. Sharing the
// in-flight promise across calls means a second call just waits on the
// first instead of racing it.
let repairInFlight = null;

export async function repairMissingCourses() {
  if (repairInFlight) return repairInFlight;
  repairInFlight = doRepairMissingCourses().finally(() => { repairInFlight = null; });
  return repairInFlight;
}

async function doRepairMissingCourses() {
  const db = await getDb();
  const missing = await db.getAllAsync(
    "SELECT DISTINCT session_id FROM trackpoints WHERE course IS NULL AND lat IS NOT NULL AND lon IS NOT NULL"
  );
  if (!missing.length) return { repaired: 0 };

  // One individual UPDATE per point (some sessions have several thousand)
  // with no transaction made this take long enough that SessionsScreen's
  // load() — which awaits this before rendering anything — looked like it
  // had hung with an empty list. Wrapping each session's points in a
  // single transaction is the same fix TrackpointRepository.insertBatch()
  // already uses for bulk writes.
  for (const { session_id } of missing) {
    const points = await db.getAllAsync(
      'SELECT id, lat, lon FROM trackpoints WHERE session_id = ? AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY timestamp ASC',
      [session_id]
    );
    if (points.length < 2) continue;

    await db.withTransactionAsync(async () => {
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const cur = points[i];
        if (prev.lat === cur.lat && prev.lon === cur.lon) continue;
        const course = bearingDeg(prev.lat, prev.lon, cur.lat, cur.lon);
        await db.runAsync('UPDATE trackpoints SET course = ? WHERE id = ?', [course, cur.id]);
      }
    });
  }

  return { repaired: missing.length };
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

  const records = fillMissingCourses(fillMissingSpeeds(data.records || []));
  const heartRates = records.map((r) => r.heart_rate).filter((v) => v != null);

  const maxSpeedMps = resolveSpeed(session, records, 'max');
  const avgSpeedMps = resolveSpeed(session, records, 'avg');
  const maxSpeedKn = toKn(maxSpeedMps);
  const fitDate = isoDate(session.start_time);

  onProgress?.('Checking for a matching session…', 0.5);
  // The sessions CSV (SessionCsvImporter.js) is the primary source for
  // sessions + gear now — a FIT file's own generated id ('fit_<timestamp>')
  // has no relation to whatever session_id that CSV carries for the same
  // real session, so look up by date + closest peak speed instead of by
  // id. Falls back to creating a bare, gear-less session (the old
  // behaviour) when nothing matches — e.g. this session hasn't been
  // brought in via CSV yet.
  //
  // Date + speed alone isn't enough — two real sessions on the same day
  // (an AM and a PM session) can easily land within 1kn of each other's
  // peak speed, which silently matched the second FIT import onto the
  // first session and discarded it as "already imported". Start time
  // must also be within MAX_TIME_DIFF_MINUTES to accept a match.
  let sessionId = resolveSessionId(session, records, asset);
  let matched = null;
  const fitStartMinutes = timeToMinutes(isoTime(session.start_time));
  if (fitDate != null) {
    const sameDay = await SessionRepository.getByDate(fitDate);
    let bestDiff = Infinity;
    for (const candidate of sameDay) {
      if (candidate.max_speed_kn == null || maxSpeedKn == null) continue;
      const candidateMinutes = timeToMinutes(candidate.start_time);
      if (fitStartMinutes != null && candidateMinutes != null &&
          Math.abs(fitStartMinutes - candidateMinutes) > MAX_TIME_DIFF_MINUTES) continue;
      const diff = Math.abs(candidate.max_speed_kn - maxSpeedKn);
      if (diff < bestDiff) { bestDiff = diff; matched = candidate; }
    }
    if (bestDiff > 1.0) matched = null;
  }
  if (matched) sessionId = matched.session_id;

  const db = await getDb();
  const alreadyHasTrackpoints = await db.getFirstAsync(
    'SELECT 1 FROM trackpoints WHERE session_id = ? LIMIT 1',
    [sessionId]
  );
  if (alreadyHasTrackpoints) {
    onProgress?.('Already imported', 1);
    return { duplicate: true, sessionId };
  }

  if (!matched) {
    onProgress?.('Saving session…', 0.7);
    await SessionRepository.insert({
      session_id: sessionId,
      date: fitDate,
      start_time: isoTime(session.start_time),
      end_time: isoTime(session.timestamp),
      duration_s: session.total_elapsed_time ?? null,
      distance_m: session.total_distance ?? null,
      max_speed_kn: maxSpeedKn,
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
  }

  onProgress?.(`Saving ${records.length} trackpoints…`, 0.85);
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

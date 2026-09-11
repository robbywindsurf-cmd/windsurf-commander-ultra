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
const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

function toDegrees(semicircles) {
  if (semicircles === null || semicircles === undefined) return null;
  return semicircles * SEMICIRCLE_TO_DEG;
}

function isoDate(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function isoTime(date) {
  return date ? date.toISOString().slice(11, 16) : null;
}

function toKn(mps) {
  return mps != null ? Math.round(mps * MPS_TO_KN * 10) / 10 : null;
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
        toDegrees(r.position_lat),
        toDegrees(r.position_long),
        r.speed ?? null,
        null,
        r.heart_rate ?? null,
        r.altitude ?? null,
      ]
    );
  }
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

  const records = data.records || [];
  const heartRates = records.map((r) => r.heart_rate).filter((v) => v != null);

  onProgress?.('Checking for duplicates…', 0.5);
  const sessionId = 'fit_' + (session.start_time ? session.start_time.getTime() : Date.now());
  const existing = await SessionRepository.getById(sessionId);
  if (existing) {
    onProgress?.('Already imported', 1);
    return { duplicate: true, sessionId };
  }

  onProgress?.('Saving session…', 0.7);
  await SessionRepository.insert({
    session_id: sessionId,
    date: isoDate(session.start_time),
    start_time: isoTime(session.start_time),
    end_time: isoTime(session.timestamp),
    duration_s: session.total_elapsed_time ?? null,
    distance_m: session.total_distance ?? null,
    max_speed_kn: toKn(session.max_speed),
    avg_speed_kn: toKn(session.avg_speed),
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
      maxSpeedKn: toKn(session.max_speed),
      distanceKm: session.total_distance != null ? Math.round(session.total_distance / 100) / 10 : null,
    },
  };
}

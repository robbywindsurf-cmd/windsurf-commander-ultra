// RameHeadWindService.js
// Ported from ~/Downloads/backfill_wind_from_ramehead.py — same source
// (NCI Rame Head lookout's published met archive), same reliability logic
// (Rame Head is an exposed headland: good for SSE-through-W-to-NNW wind,
// sheltered/unreliable for northerlies), same "use it if better" decision.
//
// Adapted for this app's schema: the Python script updated
// sessions.wind_speed/wind_direction/peak_gust (production Postgres
// columns that don't exist here — this app keeps wind in weather_cache,
// keyed by beach + date, not on the session row itself). Gust isn't a
// weather_cache column either, so it's folded into forecast_json instead
// of a schema change for one extra field.
import { SessionRepository, BeachRepository, WeatherRepository } from '@commandersuite/core';

const BASE_URL = 'https://www.nci-ramehead.org.uk/weather/archive/';
const RATE_LIMIT_MS = 400;

// Rame Head is only relevant to sessions actually sailed near it — this is
// the same bounding box the Python script used (Torpoint/Rame sailing
// area), not an app-wide default location.
const RAME_AREA = { latMin: 50.36, latMax: 50.38, lonMin: -4.22, lonMax: -4.18 };

const COMPASS_TO_DEG = {
  N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157,
  S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337,
};
const DEG_TO_COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const RAME_GOOD_MIN = 160;
const RAME_GOOD_MAX = 340;

function mphToKnots(mph) {
  return Math.round(mph * 0.868976 * 10) / 10;
}

function compassToDeg(compass) {
  return COMPASS_TO_DEG[(compass || '').trim().toUpperCase()] ?? null;
}

function degToCompass(deg) {
  if (deg == null) return null;
  return DEG_TO_COMPASS[Math.round(deg / 22.5) % 16];
}

function circularMeanDeg(angles) {
  if (!angles.length) return null;
  const sinSum = angles.reduce((s, a) => s + Math.sin((a * Math.PI) / 180), 0);
  const cosSum = angles.reduce((s, a) => s + Math.cos((a * Math.PI) / 180), 0);
  const mean = (Math.atan2(sinSum / angles.length, cosSum / angles.length) * 180) / Math.PI;
  return Math.round(((mean % 360) + 360) % 360);
}

function isRameReliable(deg) {
  if (deg == null) return false;
  return deg >= RAME_GOOD_MIN && deg <= RAME_GOOD_MAX;
}

function dateToFilenameBase(dateStr) {
  const [yyyy, mm, dd] = dateStr.split('-');
  return `${yyyy.slice(2)}${mm}${dd}_rame_met`;
}

async function fetchRameHeadFile(dateStr) {
  const base = dateToFilenameBase(dateStr);
  for (const ext of ['.dat', '.txt']) {
    try {
      const res = await fetch(BASE_URL + base + ext, {
        headers: { 'User-Agent': 'WindsurfCommanderUltra/1.0' },
      });
      if (res.ok) {
        const text = await res.text();
        if (text.length > 1000) return text;
      }
    } catch (err) {
      // try the other extension
    }
  }
  return null;
}

function extractHHMM(t) {
  if (!t) return null;
  const trimmed = t.trim();
  const fromIso = trimmed.slice(11, 16);
  if (fromIso.includes(':')) return fromIso;
  const fromStart = trimmed.slice(0, 5);
  if (fromStart.includes(':')) return fromStart;
  return null;
}

// Parses the archive's whitespace-delimited rows after the '---' header
// separator. Columns (0-indexed): [1]=time HH:MM, [7]=wind mph,
// [8]=wind compass dir, [10]=gust mph — same layout the Python script used.
function parseRameHeadFile(text, startHHMM, endHHMM) {
  const lines = text.split('\n');
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('---')) {
      dataStart = i + 1;
      break;
    }
  }

  const windSpeeds = [];
  const windDirs = [];
  const gustSpeeds = [];

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('---')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 12) continue;

    const timeStr = parts[1];
    if (!timeStr || !timeStr.includes(':')) continue;
    const [h, m] = timeStr.split(':');
    const timePadded = `${h.padStart(2, '0')}:${m}`;

    if (startHHMM && endHHMM && (timePadded < startHHMM || timePadded > endHHMM)) continue;

    const windMph = parseFloat(parts[7]);
    const windCompass = parts[8];
    const gustMph = parseFloat(parts[10]);
    if (Number.isNaN(windMph)) continue;

    windSpeeds.push(mphToKnots(windMph));
    if (!Number.isNaN(gustMph)) gustSpeeds.push(mphToKnots(gustMph));
    const dir = compassToDeg(windCompass);
    if (dir != null) windDirs.push(dir);
  }

  if (!windSpeeds.length) return null;

  return {
    avgWindKn: Math.round((windSpeeds.reduce((a, b) => a + b, 0) / windSpeeds.length) * 10) / 10,
    avgWindDirDeg: circularMeanDeg(windDirs),
    maxGustKn: gustSpeeds.length ? Math.max(...gustSpeeds) : null,
    sampleCount: windSpeeds.length,
  };
}

function inRameArea(session) {
  return (
    session.lat != null && session.lon != null &&
    session.lat >= RAME_AREA.latMin && session.lat <= RAME_AREA.latMax &&
    session.lon >= RAME_AREA.lonMin && session.lon <= RAME_AREA.lonMax
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const RameHeadWindService = {
  // Sessions this data source can even apply to (same bounding box as the
  // Python script), for a "X sessions in range" style UI if wanted.
  async getEligibleSessions() {
    const sessions = await SessionRepository.getAll();
    return sessions.filter(inRameArea);
  },

  // Backfills one session's weather_cache row with Rame Head data if it's
  // a better source than what's already cached (same 3-way decision as the
  // Python script: no existing data / reliable direction / reads higher).
  // Returns { updated, reason } or null if the session isn't in range.
  async backfillSession(session, { dryRun = false } = {}) {
    if (!inRameArea(session)) return null;

    const [beaches] = await Promise.all([BeachRepository.getAll()]);
    let nearestName = 'Torpoint';
    let bestDist = Infinity;
    for (const b of beaches) {
      if (b.lat == null || b.lon == null) continue;
      const dist = (b.lat - session.lat) ** 2 + (b.lon - session.lon) ** 2;
      if (dist < bestDist) { bestDist = dist; nearestName = b.name; }
    }

    const existing = await WeatherRepository.getForBeach(nearestName, session.date);

    const fileText = await fetchRameHeadFile(session.date);
    if (!fileText) return { updated: false, reason: 'no Rame Head file for this date' };

    const startHHMM = extractHHMM(session.start_time);
    const endHHMM = extractHHMM(session.end_time);
    let windData = parseRameHeadFile(fileText, startHHMM, endHHMM);
    if (!windData) windData = parseRameHeadFile(fileText, null, null);
    if (!windData) return { updated: false, reason: 'no usable data rows in file' };

    const reliable = isRameReliable(windData.avgWindDirDeg);
    const existingWindKn = existing?.best_wind_kn ?? null;

    let useRame = false;
    let reason = '';
    if (existingWindKn == null) {
      useRame = true;
      reason = 'no existing data';
    } else if (reliable) {
      useRame = true;
      reason = 'reliable direction';
    } else if (windData.avgWindKn > existingWindKn) {
      useRame = true;
      reason = `higher (${windData.avgWindKn} > ${existingWindKn}kn)`;
    } else {
      reason = `existing higher (${existingWindKn} >= ${windData.avgWindKn}kn)`;
    }

    if (!useRame || dryRun) return { updated: false, reason, wouldUse: useRame };

    await WeatherRepository.cache({
      beach_name: nearestName,
      forecast_date: session.date,
      best_wind_kn: windData.avgWindKn,
      best_wind_dir: windData.avgWindDirDeg,
      best_time: startHHMM,
      wave_height_m: existing?.wave_height_m ?? null,
      temperature_c: existing?.temperature_c ?? null,
      forecast_json: {
        source: 'rame-head',
        gust_kn: windData.maxGustKn,
        sample_count: windData.sampleCount,
        compass: degToCompass(windData.avgWindDirDeg),
      },
    });

    return { updated: true, reason };
  },

  // Walks every session in the Rame Head area, 400ms apart between network
  // fetches (matching the Python script's own rate limiting for the same
  // public archive), reporting (completed, total) after each session.
  async backfillAll(onProgress, { dryRun = false } = {}) {
    const sessions = await this.getEligibleSessions();
    const total = sessions.length;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < sessions.length; i++) {
      try {
        const result = await this.backfillSession(sessions[i], { dryRun });
        if (result?.updated) updated += 1;
        else skipped += 1;
        await sleep(RATE_LIMIT_MS);
      } catch (err) {
        failed += 1;
      }
      onProgress?.(i + 1, total);
    }

    return { updated, skipped, failed, total };
  },
};

import { getDb, SessionRepository, BeachRepository, WeatherRepository, UserStore } from '@commandersuite/core';

// Open-Meteo's free tier asks callers to be reasonable about request rate.
const RATE_LIMIT_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ~0.05° is roughly 5-6km at UK latitudes — close enough to call "the same
// beach", not so wide that a session sailed somewhere else entirely gets
// mislabelled with whatever beach happens to be nearest on record. Without
// this cap, a single-beach `beaches` table (e.g. just "Torpoint") made
// nearestBeachName() snap EVERY session to that name regardless of real
// distance — which, combined with weather_cache's UNIQUE(beach_name, date)
// constraint, could silently overwrite Torpoint's own cached weather for
// that date with a distant session's reading.
const MAX_BEACH_MATCH_DEG = 0.05;

function nearestBeachName(beaches, beachId, lat, lon) {
  if (beachId) {
    const byId = beaches.find((b) => b.id === beachId);
    if (byId) return byId.name;
  }
  if (lat == null || lon == null || !beaches.length) return null;

  let best = null;
  let bestDist = Infinity;
  for (const b of beaches) {
    if (b.lat == null || b.lon == null) continue;
    const dist = (b.lat - lat) ** 2 + (b.lon - lon) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  if (!best || bestDist > MAX_BEACH_MATCH_DEG ** 2) return null;
  return best.name;
}

// Synthetic weather_cache label for a session with no nearby known beach —
// unique per location so it never collides with (and overwrites) a real
// beach's cached weather for the same date.
function locationLabel(lat, lon) {
  return `Session ${lat.toFixed(3)},${lon.toFixed(3)}`;
}

async function hasWeatherForDate(date) {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT 1 FROM weather_cache WHERE forecast_date = ? LIMIT 1', [date]);
  return !!row;
}

// Fetches one session date's weather (Open-Meteo archive + marine) and
// caches it. Picks the hourly reading nearest the session's start time.
// `fallbackBeach` (the user's favourite beach) supplies lat/lon and a name
// when the session itself has neither.
async function fetchAndCacheWeather(session, beachName, fallbackBeach) {
  const lat = session.lat ?? fallbackBeach?.lat;
  const lon = session.lon ?? fallbackBeach?.lon;
  const date = session.date;
  if (lat == null || lon == null) {
    throw new Error('No location for this session and no favourite beach set');
  }

  const archiveUrl =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${date}&end_date=${date}` +
    `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m&wind_speed_unit=kn&timezone=UTC`;
  const marineUrl =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}` +
    `&start_date=${date}&end_date=${date}` +
    `&hourly=wave_height&models=best_match&timezone=UTC`;

  const [archiveRes, marineRes] = await Promise.all([fetch(archiveUrl), fetch(marineUrl)]);
  if (!archiveRes.ok) throw new Error(`Open-Meteo archive error ${archiveRes.status}`);
  const archive = await archiveRes.json();
  const marine = marineRes.ok ? await marineRes.json() : null;

  const times = archive?.hourly?.time || [];
  if (!times.length) throw new Error('No archive data for this date');

  const targetMs = session.start_time
    ? new Date(`${date}T${session.start_time}`).getTime()
    : new Date(`${date}T12:00`).getTime();

  let bestIdx = 0;
  let bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });

  let waveHeightM = null;
  if (marine?.hourly?.time) {
    const mIdx = marine.hourly.time.indexOf(times[bestIdx]);
    waveHeightM = mIdx >= 0 ? marine.hourly.wave_height?.[mIdx] ?? null : null;
  }

  const weather = {
    beach_name: beachName || fallbackBeach?.name || null,
    forecast_date: date,
    best_wind_kn: archive.hourly.wind_speed_10m?.[bestIdx] ?? null,
    best_gust_kn: archive.hourly.wind_gusts_10m?.[bestIdx] ?? null,
    best_wind_dir: archive.hourly.wind_direction_10m?.[bestIdx] ?? null,
    best_time: times[bestIdx]?.slice(11, 16) ?? null,
    wave_height_m: waveHeightM,
    temperature_c: archive.hourly.temperature_2m?.[bestIdx] ?? null,
    forecast_json: { source: 'open-meteo-archive', hourly_index: bestIdx },
  };

  await WeatherRepository.cache(weather);
}

// Fetches just wind + gust for one already-cached weather_cache row (no
// session needed — beach name/date/lat/lon come from the row itself via
// `beaches`), and updates best_gust_kn in place without touching the rest
// of the row. Used to retrofit gust data onto rows that predate the
// windgusts_10m field being requested at all (historical CSV imports and
// earlier archive backfills alike).
async function fetchAndCacheGust(row, beach) {
  const lat = beach?.lat;
  const lon = beach?.lon;
  if (lat == null || lon == null) throw new Error(`No coordinates for beach "${row.beach_name}"`);

  const archiveUrl =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${row.forecast_date}&end_date=${row.forecast_date}` +
    `&hourly=wind_gusts_10m&wind_speed_unit=kn&timezone=UTC`;

  const res = await fetch(archiveUrl);
  if (!res.ok) throw new Error(`Open-Meteo archive error ${res.status}`);
  const archive = await res.json();

  const times = archive?.hourly?.time || [];
  if (!times.length) throw new Error('No archive data for this date');

  let bestIdx = 0;
  if (row.best_time) {
    const targetMs = new Date(`${row.forecast_date}T${row.best_time}`).getTime();
    let bestDiff = Infinity;
    times.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - targetMs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    });
  }

  const gustKn = archive.hourly.wind_gusts_10m?.[bestIdx] ?? null;
  if (gustKn == null) return false;

  const db = await getDb();
  await db.runAsync(
    'UPDATE weather_cache SET best_gust_kn = ? WHERE beach_name = ? AND forecast_date = ?',
    [gustKn, row.beach_name, row.forecast_date]
  );
  return true;
}

export const WeatherBackfillService = {
  // Exposed so SessionDetailScreen can look weather_cache up with the same
  // beach-name resolution fetchWeatherForSession() writes it under — a
  // session's weather must be looked up by its own lat/lon, not the
  // user's favourite beach (which was wrongly used for every session's
  // display regardless of where it was actually sailed).
  nearestBeachName,
  locationLabel,

  // Single-session version of backfillAllSessions() — fetches historical
  // weather for just this one session's own date/location (its own
  // lat/lon when it has them, else the favourite beach), rather than
  // requiring the bulk "X sessions missing weather" pass. Returns the
  // freshly-cached row.
  //
  // Uses a synthetic per-location label (not the favourite beach's name)
  // when the session isn't close to any known beach, so its weather never
  // overwrites — or gets confused with — a real beach's cached reading for
  // the same date.
  async fetchWeatherForSession(session) {
    const [beaches, favouriteBeach] = await Promise.all([
      BeachRepository.getAll(),
      UserStore.getFavouriteBeach(),
    ]);
    const knownBeachName = nearestBeachName(beaches, session.beach_id, session.lat, session.lon);
    const lat = session.lat ?? favouriteBeach?.lat;
    const lon = session.lon ?? favouriteBeach?.lon;
    const beachName = knownBeachName || (lat != null && lon != null ? locationLabel(lat, lon) : favouriteBeach?.name);
    await fetchAndCacheWeather(session, beachName, favouriteBeach);
    return WeatherRepository.getForBeach(beachName, session.date);
  },

  // Count of distinct session dates with no weather_cache entry at all —
  // for the "X sessions missing weather data" prompt before starting.
  async countMissing() {
    const sessions = await SessionRepository.getAll();
    const dates = [...new Set(sessions.map((s) => s.date).filter(Boolean))];
    let missing = 0;
    for (const date of dates) {
      if (!(await hasWeatherForDate(date))) missing += 1;
    }
    return missing;
  },

  // Walks every session, fetching + caching weather for any date that
  // doesn't have it yet (one API call per distinct missing date, not per
  // session), reporting (completed, total) after each session processed.
  async backfillAllSessions(onProgress) {
    const [sessions, beaches, favouriteBeach] = await Promise.all([
      SessionRepository.getAll(),
      BeachRepository.getAll(),
      UserStore.getFavouriteBeach(),
    ]);
    const total = sessions.length;
    let completed = 0;
    let count = 0;
    const errors = [];
    const processedDates = new Set();

    for (const session of sessions) {
      completed += 1;
      try {
        if (session.date && !processedDates.has(session.date)) {
          processedDates.add(session.date);
          if (!(await hasWeatherForDate(session.date))) {
            const beachName = nearestBeachName(beaches, session.beach_id, session.lat, session.lon);
            await fetchAndCacheWeather(session, beachName, favouriteBeach);
            count += 1;
            await sleep(RATE_LIMIT_MS);
          }
        }
      } catch (err) {
        errors.push({ sessionId: session.session_id, message: err.message });
      }
      onProgress?.(completed, total);
    }

    return { success: errors.length === 0, count, errors };
  },

  // Count of cached weather rows (from CSV import or an earlier backfill,
  // either way from before windgusts_10m was ever requested) with no
  // gust figure yet.
  async countMissingGusts() {
    const db = await getDb();
    const row = await db.getFirstAsync('SELECT COUNT(*) as n FROM weather_cache WHERE best_gust_kn IS NULL');
    return row?.n ?? 0;
  },

  // Retrofits best_gust_kn onto every existing weather_cache row that
  // doesn't have one — one archive call per row (beach name resolved
  // against `beaches` for lat/lon), rate-limited the same as
  // backfillAllSessions().
  async backfillMissingGusts(onProgress) {
    const db = await getDb();
    const [rows, beaches] = await Promise.all([
      db.getAllAsync('SELECT beach_name, forecast_date, best_time FROM weather_cache WHERE best_gust_kn IS NULL'),
      BeachRepository.getAll(),
    ]);
    const beachByName = new Map(beaches.map((b) => [b.name, b]));

    const total = rows.length;
    let completed = 0;
    let count = 0;
    const errors = [];

    for (const row of rows) {
      completed += 1;
      try {
        const beach = beachByName.get(row.beach_name);
        const updated = await fetchAndCacheGust(row, beach);
        if (updated) count += 1;
        await sleep(RATE_LIMIT_MS);
      } catch (err) {
        errors.push({ beachName: row.beach_name, date: row.forecast_date, message: err.message });
      }
      onProgress?.(completed, total);
    }

    return { success: errors.length === 0, count, errors };
  },
};

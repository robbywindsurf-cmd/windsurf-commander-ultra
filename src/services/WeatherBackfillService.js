import { getDb, SessionRepository, BeachRepository, WeatherRepository, UserStore } from '@commandersuite/core';

// Open-Meteo's free tier asks callers to be reasonable about request rate.
const RATE_LIMIT_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  return best?.name ?? null;
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
    `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=kn&timezone=UTC`;
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
    best_wind_dir: archive.hourly.wind_direction_10m?.[bestIdx] ?? null,
    best_time: times[bestIdx]?.slice(11, 16) ?? null,
    wave_height_m: waveHeightM,
    temperature_c: archive.hourly.temperature_2m?.[bestIdx] ?? null,
    forecast_json: { source: 'open-meteo-archive', hourly_index: bestIdx },
  };

  await WeatherRepository.cache(weather);
}

export const WeatherBackfillService = {
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
};

import {
  getDb, SessionRepository, AnalysisRepository, EquipmentRepository, BeachRepository, TideRepository,
  WeatherRepository,
} from '@commandersuite/core';

const MPS_TO_KN = 1.94384;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// Torpoint, Cornwall — used when a session has no lat/lon of its own.
const DEFAULT_LAT = 50.37154;
const DEFAULT_LON = -4.1908264;

function degreesToCompass(deg) {
  if (deg == null) return null;
  return COMPASS[Math.round(deg / 22.5) % 16];
}

// Rough stance descriptor from a knee angle — straighter leg reads as a
// higher angle (closer to 180°), deep bend as a much lower one.
function describeKneeBend(angle) {
  if (angle == null) return null;
  if (angle >= 165) return 'Straight';
  if (angle >= 145) return 'Slightly bent';
  if (angle >= 115) return 'Moderate bend';
  return 'Deep bend';
}

// Backfills weather_cache for a session date with no entry, from Open-Meteo's
// free historical archive (weather) + marine (wave height) APIs. Picks the
// hourly reading nearest the session's start time and caches it exactly
// like a live forecast fetch would, so future lookups hit weather_cache.
async function backfillHistoricalWeather(session, beachName) {
  const lat = session.lat ?? DEFAULT_LAT;
  const lon = session.lon ?? DEFAULT_LON;
  const date = session.date;
  if (!date) return null;

  try {
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
    if (!times.length) return null;

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
      beach_name: beachName || 'Torpoint',
      forecast_date: date,
      best_wind_kn: archive.hourly.wind_speed_10m?.[bestIdx] ?? null,
      best_wind_dir: archive.hourly.wind_direction_10m?.[bestIdx] ?? null,
      best_time: times[bestIdx]?.slice(11, 16) ?? null,
      wave_height_m: waveHeightM,
      temperature_c: archive.hourly.temperature_2m?.[bestIdx] ?? null,
      forecast_json: { source: 'open-meteo-archive', hourly_index: bestIdx },
    };

    await WeatherRepository.cache(weather);
    return weather;
  } catch (err) {
    console.warn('[PeakMomentService] weather backfill failed:', err.message);
    return null;
  }
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

export const PeakMomentService = {
  // Assembles the "peak moment" for a session: the highest-speed
  // trackpoint, the nearest biomechanics frame to that instant, the
  // day's cached weather, the session's gear, and the latest skeleton
  // frame image — or null if the session has no GPS trackpoints at all.
  async findPeakMoment(sessionId) {
    const db = await getDb();

    const peakTp = await db.getFirstAsync(
      'SELECT * FROM trackpoints WHERE session_id = ? ORDER BY speed_ms DESC LIMIT 1',
      [sessionId]
    );
    if (!peakTp) return null;

    const session = await SessionRepository.getById(sessionId);

    const [frame, weatherRow, lastAnalysis, beaches, gearCombos, tideState] = await Promise.all([
      peakTp.timestamp ? AnalysisRepository.getNearestFrame(sessionId, peakTp.timestamp) : null,
      session?.date
        ? db.getFirstAsync(
            'SELECT * FROM weather_cache WHERE forecast_date = ? ORDER BY fetched_at DESC LIMIT 1',
            [session.date]
          )
        : null,
      db.getFirstAsync(
        'SELECT last_frame_base64 FROM video_analyses WHERE session_id = ? ORDER BY analysed_at DESC LIMIT 1',
        [sessionId]
      ),
      BeachRepository.getAll(),
      EquipmentRepository.getGearCombos(),
      peakTp.timestamp ? TideRepository.getTideStateAtTime(peakTp.timestamp) : null,
    ]);

    const gearCombo = session?.gear_combo_id
      ? gearCombos.find((c) => c.id === session.gear_combo_id)
      : null;

    const beachName = nearestBeachName(beaches, session?.beach_id, peakTp.lat, peakTp.lon);
    const weather = weatherRow || (session ? await backfillHistoricalWeather(session, beachName) : null);

    return {
      sessionId,
      date: session?.date ?? null,
      peakSpeedKn: peakTp.speed_ms != null ? Math.round(peakTp.speed_ms * MPS_TO_KN * 100) / 100 : null,
      peakTimestamp: peakTp.timestamp,
      lat: peakTp.lat,
      lon: peakTp.lon,
      beachName,
      skeletonFrame: lastAnalysis?.last_frame_base64 ?? null,
      windKn: weather?.best_wind_kn ?? null,
      windDir: degreesToCompass(weather?.best_wind_dir),
      waveHeightM: weather?.wave_height_m ?? null,
      tempC: weather?.temperature_c ?? null,
      boardName: gearCombo?.board_name ?? null,
      sailName: gearCombo?.sail_name ?? null,
      sailSize: gearCombo?.sail_size ?? null,
      frontLegDesc: describeKneeBend(frame?.left_knee_angle),
      backLegDesc: describeKneeBend(frame?.right_knee_angle),
      hr: peakTp.hr ?? null,
      tideM: tideState?.value_m ?? null,
      tideType: tideState?.tide_type ?? null,
      tideDescription: tideState?.description ?? null,
      tideIsRising: tideState?.isRising ?? null,
    };
  },
};

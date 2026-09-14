import {
  getDb, SessionRepository, AnalysisRepository, EquipmentRepository, BeachRepository, TideRepository,
} from '@commandersuite/core';

const MPS_TO_KN = 1.94384;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

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

    return {
      sessionId,
      date: session?.date ?? null,
      peakSpeedKn: peakTp.speed_ms != null ? Math.round(peakTp.speed_ms * MPS_TO_KN * 100) / 100 : null,
      peakTimestamp: peakTp.timestamp,
      lat: peakTp.lat,
      lon: peakTp.lon,
      beachName,
      skeletonFrame: lastAnalysis?.last_frame_base64 ?? null,
      windKn: weatherRow?.best_wind_kn ?? null,
      windDir: degreesToCompass(weatherRow?.best_wind_dir),
      waveHeightM: weatherRow?.wave_height_m ?? null,
      tempC: weatherRow?.temperature_c ?? null,
      weatherMissing: !weatherRow,
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

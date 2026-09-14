import {
  getDb, SessionRepository, TrackpointRepository, EquipmentRepository,
  WeightRepository, UserStore,
} from '@commandersuite/core';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function degreesToCompass(deg) {
  if (deg == null) return null;
  return COMPASS[Math.round(deg / 22.5) % 16];
}

export const StatsService = {
  // Everything the Stats screen needs, assembled in one call so the screen
  // itself just renders — all local SQLite, nothing remote.
  async getStats() {
    const db = await getDb();

    const [
      pbSession, allSessions, yearByYear, gearCombos,
      bestHeading, lowSpeedPct, weightLog, favouriteBeach,
    ] = await Promise.all([
      SessionRepository.getPersonalBestSession(),
      SessionRepository.getAll(),
      SessionRepository.getYearByYear(),
      EquipmentRepository.getGearCombos(),
      TrackpointRepository.getBestHeadingBucket(),
      TrackpointRepository.getLowSpeedPercentage(),
      WeightRepository.getAll(),
      UserStore.getFavouriteBeach(),
    ]);

    // Personal best card — gear via its session's combo, wind via cached
    // weather for that session's date (best-effort; sessions don't store
    // wind directly).
    let pb = null;
    if (pbSession) {
      const combo = pbSession.gear_combo_id ? gearCombos.find((c) => c.id === pbSession.gear_combo_id) : null;
      const weatherRow = await db.getFirstAsync(
        'SELECT best_wind_dir FROM weather_cache WHERE forecast_date = ? ORDER BY fetched_at DESC LIMIT 1',
        [pbSession.date]
      );
      pb = {
        speedKn: pbSession.max_speed_kn,
        date: pbSession.date,
        windDirText: degreesToCompass(weatherRow?.best_wind_dir),
        boardName: combo?.board_name ?? null,
        sailName: combo?.sail_name ?? null,
        sailSize: combo?.sail_size ?? null,
      };
    }

    // Stats grid
    const earliestDate = allSessions.length
      ? allSessions.reduce((min, s) => (s.date < min ? s.date : min), allSessions[0].date)
      : null;
    const totalSeconds = allSessions.reduce((sum, s) => sum + (s.duration_s || 0), 0);
    const speeds = allSessions.map((s) => s.max_speed_kn).filter((v) => v != null);
    const avgPeak = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;
    const lastOut = allSessions.length
      ? allSessions.reduce((max, s) => (s.date > max ? s.date : max), allSessions[0].date)
      : null;

    // Money tack — best heading bucket, described against the favourite
    // beach, with the average cached wind direction there as context
    // (an approximation, not a strict per-session correlation).
    let moneyTack = null;
    if (bestHeading) {
      const avgWindRow = favouriteBeach
        ? await db.getFirstAsync(
            'SELECT AVG(best_wind_dir) as avg_dir, AVG(best_wind_kn) as avg_kn FROM weather_cache WHERE beach_name = ?',
            [favouriteBeach.name]
          )
        : null;
      moneyTack = {
        headingBucket: bestHeading.heading_bucket,
        headingText: degreesToCompass(bestHeading.heading_bucket),
        avgSpeedKn: Math.round(bestHeading.avg_speed_ms * 1.94384 * 10) / 10,
        beachName: favouriteBeach?.name ?? null,
        windDirText: degreesToCompass(avgWindRow?.avg_dir),
        windDirDeg: avgWindRow?.avg_dir != null ? Math.round(avgWindRow.avg_dir) : null,
      };
    }

    return {
      personalBest: pb,
      grid: {
        totalSessions: allSessions.length,
        earliestDate,
        totalHours: totalSeconds / 3600,
        avgPeakKn: avgPeak,
        lastOut,
      },
      yearByYear,
      moneyTack,
      lowSpeedPercentage: lowSpeedPct,
      weightLog,
    };
  },
};

import {
  getDb, SessionRepository, TrackpointRepository, EquipmentRepository,
  WeightRepository, UserStore,
} from '@commandersuite/core';
import { PEER_SUMMARY_URL } from '../config';

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

  /**
   * The frame the rider's own biomechanics should be compared against.
   *
   * Peer figures on the server are built from each rider's **peak-speed** frame
   * (poseAnalysisPipeline uploads peakFrame for that reason), so this prefers
   * speed too — but it must not *require* it. GPS-matched speed is currently
   * absent from almost every analysis on the device (17, 18 and 14 all have
   * `speed_kn` null on every detected frame, despite populated `utc_timestamp`
   * and 3463 trackpoints on the session), so requiring speed here would silently
   * show the rider nothing while perfectly good biomechanics sat in the data.
   *
   * Order: newest analysis first, then highest speed (SQLite sorts NULLs last in
   * DESC, so a peak frame still wins wherever one exists), falling back to the
   * newest frame that carries biomechanics at all. Rows without any biomechanics
   * are excluded — they would render as an all-dashes row.
   */
  async getYourPeakFrame() {
    const db = await getDb();
    return db.getFirstAsync(`
      SELECT analysis_id, time_s, speed_kn,
             right_knee_angle, back_foot_pct, fin_load_kg
      FROM frame_data
      WHERE detected = 1
        AND (back_foot_pct IS NOT NULL OR right_knee_angle IS NOT NULL)
      ORDER BY analysis_id DESC, speed_kn DESC, time_s ASC
      LIMIT 1
    `);
  },

  /**
   * Peer comparison for the rider's own biometric category, cache-first.
   *
   * The local row is written by this method only — the app reads
   * category_summaries for the AI prompt too (PromptBuilder.buildPeerComparison),
   * and nothing else populates it.
   *
   * Cache TTL is computed locally rather than storing the server's valid_until:
   * SQLite compares its own 'YYYY-MM-DD HH:MM:SS' format, and the server sends
   * ISO 'YYYY-MM-DDTHH:MM:SSZ'. Those two sort against `datetime('now')`
   * differently for the same instant, so a stored ISO value would make the
   * staleness check subtly wrong.
   */
  async getPeerComparison({ forceRefresh = false } = {}) {
    const db = await getDb();

    const biometrics = await UserStore.getBiometrics();
    if (!biometrics?.biometric_category) return { status: 'no-profile' };

    const categoryKey = biometrics.biometric_category;
    const yourPeak = await this.getYourPeakFrame();

    if (!forceRefresh) {
      const cached = await db.getFirstAsync(
        `SELECT * FROM category_summaries
         WHERE category_key = ? AND sport = 'windsurf' AND valid_until > datetime('now')`,
        [categoryKey]
      );
      if (cached) return { status: 'ready', source: 'cache', row: cached, yourPeak, biometrics };
    }

    // Nothing cached and still fresh — try Oracle. A failure here just means no
    // peer data this time; it must never break the Stats screen, which is
    // otherwise entirely local.
    try {
      const res = await fetch(`${PEER_SUMMARY_URL}?key=${encodeURIComponent(categoryKey)}&sport=windsurf`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { status: 'unavailable', reason: `HTTP ${res.status}`, yourPeak, biometrics };

      const data = await res.json().catch(() => null);
      // n8n can answer 200 with an error body when a workflow throws before its
      // Respond node, so res.ok proves nothing — the shape has to be checked.
      if (!data || typeof data.sample_count !== 'number') {
        return { status: 'unavailable', reason: 'unexpected response shape', yourPeak, biometrics };
      }

      const minimum = data.minimum_samples_required ?? 10;
      if (data.found === false || data.sample_count < minimum) {
        // Not an error — an honest "not yet". Returned so the UI can show how
        // far along the dataset is rather than a flat "unavailable".
        return { status: 'building', sampleCount: data.sample_count, minimum, yourPeak, biometrics };
      }

      await db.runAsync(
        `INSERT OR REPLACE INTO category_summaries
           (category_key, sport, sample_count, avg_back_knee_min, avg_back_knee_max,
            avg_back_foot_pct, avg_fin_load_kg, best_speed_kn, avg_speed_kn,
            common_board_vol_l, common_fin_size_cm, bands_matched, fetched_at, valid_until)
         VALUES (?, 'windsurf', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+7 days'))`,
        [
          categoryKey, data.sample_count,
          data.avg_back_knee_min ?? null, data.avg_back_knee_max ?? null,
          data.avg_back_foot_pct ?? null, data.avg_fin_load_kg ?? null,
          data.best_speed_kn ?? null, data.avg_speed_kn ?? null,
          data.common_board_vol_l ?? null, data.common_fin_size_cm ?? null,
          data.bands_matched ?? null,
        ]
      );

      const row = await db.getFirstAsync(
        'SELECT * FROM category_summaries WHERE category_key = ? AND sport = \'windsurf\'',
        [categoryKey]
      );
      return { status: 'ready', source: 'network', row, yourPeak, biometrics };
    } catch (err) {
      return { status: 'unavailable', reason: err.message, yourPeak, biometrics };
    }
  },
};

import {
  BeachRepository, WeatherRepository, TideRepository, EquipmentRepository, CoachingService,
} from '@commandersuite/core';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function degreesToCompass(deg) {
  if (deg == null) return null;
  return COMPASS[Math.round(deg / 22.5) % 16];
}

// 🎯 Good / ⚠️ Marginal / 🌊 Rough / 😴 Poor / ❓ No data.
// Rough seas are checked ahead of wind strength — a safety override, not
// just another wind band.
export function conditionIndicator(weather) {
  if (!weather) return { emoji: '❓', label: 'No data' };
  if (weather.wave_height_m != null && weather.wave_height_m > 1.5) return { emoji: '🌊', label: 'Rough' };
  if (weather.best_wind_kn == null) return { emoji: '❓', label: 'No data' };
  if (weather.best_wind_kn < 10) return { emoji: '😴', label: 'Poor' };
  if (weather.best_wind_kn <= 15) return { emoji: '⚠️', label: 'Marginal' };
  return { emoji: '🎯', label: 'Good' };
}

const today = () => new Date().toISOString().slice(0, 10);

export const WeatherService = {
  // Today's cached weather + condition badge for every beach in the
  // catalogue (BeachRepository.getAll(), not just ones the user actively
  // tracks in the Weather picker) — the grid task asked for "ALL user
  // beaches".
  async getBeachChecks() {
    const beaches = await BeachRepository.getAll();
    const date = today();
    const rows = await Promise.all(
      beaches.map(async (beach) => {
        const weather = await WeatherRepository.getForBeach(beach.name, date);
        return { beach, weather, condition: conditionIndicator(weather) };
      })
    );
    return rows;
  },

  // Free tier: pure SQLite gear-combo match, no AI text. Premium/ultimate:
  // same matched combos handed to the local AI for a natural-language
  // recommendation (ultimate uses the same local model as premium — see
  // CoachingService's Fastify TODO).
  async getKitRecommendation({ beach, weather, tideState, tier }) {
    const combos = weather
      ? await EquipmentRepository.getMatchingGearCombos(weather.best_wind_kn, weather.wave_height_m)
      : [];

    if (tier === 'free' || !weather) {
      return { mode: 'data', combos, text: null };
    }

    const combosLine = combos.length
      ? combos.map((c) => c.name || [c.board_name, c.sail_name].filter(Boolean).join(' / ')).join(', ')
      : 'none in your quiver match these conditions';

    const question =
      `What gear should I use today at ${beach?.name ?? 'my beach'}? ` +
      `Wind ${weather.best_wind_kn ?? '?'}kn ${degreesToCompass(weather.best_wind_dir) ?? ''}, ` +
      `waves ${weather.wave_height_m ?? '?'}m` +
      (tideState ? `, tide ${tideState.description}` : '') +
      `. Matching combos from my quiver: ${combosLine}.`;

    const text = await CoachingService.answerQuestion(question, {}, tier);
    return { mode: 'ai', combos, text };
  },

  // Local-AI morning briefing for one beach, grounded in that beach's own
  // cached weather (not whichever beach happens to have the highest wind
  // today, which is buildSystemPrompt's own default).
  async getBriefing({ beach, weather, tideState, tier }) {
    if (tier === 'free') return null;

    const question =
      `Give me a short morning briefing for ${beach?.name ?? 'my beach'} today. ` +
      `Include a kit recommendation from my quiver and a clear Go / Maybe / Stay home verdict.` +
      (tideState ? ` Tide right now: ${tideState.description}.` : '');

    return CoachingService.answerQuestion(question, { weather: weather || null }, tier);
  },

  // 5-day forecast for one beach from Open-Meteo (free, no key) + its
  // marine API for wave height. Returns one row per day, oldest first.
  async get5DayForecast(beach) {
    if (!beach?.lat || !beach?.lon) return [];

    const forecastUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${beach.lat}&longitude=${beach.lon}` +
      `&daily=wind_speed_10m_max,wind_direction_10m_dominant,precipitation_sum&wind_speed_unit=kn&forecast_days=5`;
    const marineUrl =
      `https://marine-api.open-meteo.com/v1/marine?latitude=${beach.lat}&longitude=${beach.lon}` +
      `&daily=wave_height_max&models=best_match&forecast_days=5`;

    const [fRes, mRes] = await Promise.all([fetch(forecastUrl), fetch(marineUrl).catch(() => null)]);
    if (!fRes.ok) throw new Error(`Open-Meteo forecast error ${fRes.status}`);
    const fData = await fRes.json();
    const mData = mRes && mRes.ok ? await mRes.json().catch(() => null) : null;

    const days = fData?.daily?.time || [];
    return days.map((date, i) => {
      const windKn = fData.daily.wind_speed_10m_max?.[i] ?? null;
      const waveM = mData?.daily?.wave_height_max?.[i] ?? null;
      const indicator = conditionIndicator({ best_wind_kn: windKn, wave_height_m: waveM });
      return {
        date,
        dayName: new Date(date).toLocaleDateString(undefined, { weekday: 'short' }),
        windKn,
        windDir: degreesToCompass(fData.daily.wind_direction_10m_dominant?.[i]),
        waveM,
        verdict: indicator.emoji,
      };
    });
  },

  async getTideStateNow() {
    return TideRepository.getTideStateAtTime(new Date().toISOString());
  },
};

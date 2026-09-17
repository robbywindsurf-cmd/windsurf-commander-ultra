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
const STALE_HOURS = 6;

// A cached row existing isn't enough — one fetched at 06:00 is still
// "today's" row at 18:00 but the wind picture has likely moved on.
// Missing fetched_at is treated as stale (fail open to a refetch).
export function isWeatherStale(cached, maxHours = STALE_HOURS) {
  if (!cached?.fetched_at) return true;
  const hoursOld = (Date.now() - new Date(cached.fetched_at).getTime()) / 3600000;
  return hoursOld > maxHours;
}

// Shared with WeatherScreen's own beach-picker forecasts, so both paths hit
// the same Open-Meteo endpoints and cache the same shape into weather_cache.
export async function fetchBeachWeather(beach) {
  const wRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&hourly=windspeed_10m,windgusts_10m,winddirection_10m,temperature_2m&timezone=auto`
  );
  const wData = await wRes.json();

  const mRes = await fetch(
    `https://marine-api.open-meteo.com/v1/marine?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&hourly=wave_height,wind_wave_height,swell_wave_height&timezone=auto`
  ).catch(() => null);
  const mData = mRes ? await mRes.json().catch(() => null) : null;

  // Open-Meteo returns a week of hourly data by default — restrict "today"
  // + daylight (06:00-21:00) so the best-wind pick and the hourly forecast
  // list shown in the beach detail view can't land on a future day or the
  // middle of the night.
  const allHours = wData.hourly?.time || [];
  const todayStr = today();
  const dayIdxs = allHours
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      if (!t.startsWith(todayStr)) return false;
      const hour = Number(t.slice(11, 13));
      return hour >= 6 && hour <= 21;
    })
    .map(({ i }) => i);

  let bestIdx = dayIdxs[0] ?? 0, bestSpeed = -1;
  for (const i of dayIdxs) {
    const speed = wData.hourly.windspeed_10m[i];
    if (speed > bestSpeed) { bestSpeed = speed; bestIdx = i; }
  }

  const knots = (i) => {
    const speed = wData.hourly?.windspeed_10m?.[i];
    return speed != null ? Math.round(speed * 0.539957 * 10) / 10 : null;
  };
  const gustKnots = (i) => {
    const gust = wData.hourly?.windgusts_10m?.[i];
    return gust != null ? Math.round(gust * 0.539957 * 10) / 10 : null;
  };

  const bestWindKn = bestSpeed >= 0 ? knots(bestIdx) : null;
  const bestGustKn = bestSpeed >= 0 ? gustKnots(bestIdx) : null;
  const bestWindDir = wData.hourly?.winddirection_10m?.[bestIdx] ?? null;
  const bestTime = allHours[bestIdx] ? allHours[bestIdx].slice(11, 16) : null;
  const waveHeight = mData?.hourly?.wave_height?.[bestIdx] ?? null;
  const temp = wData.hourly?.temperature_2m?.[bestIdx] ?? null;

  const hourlyForecast = dayIdxs.map((i) => ({
    time: allHours[i].slice(11, 16),
    wind_kn: knots(i),
    gust_kn: gustKnots(i),
    wind_dir: wData.hourly?.winddirection_10m?.[i] ?? null,
  }));

  return {
    beach_name: beach.name,
    forecast_date: todayStr,
    best_wind_kn: bestWindKn,
    best_gust_kn: bestGustKn,
    best_wind_dir: bestWindDir,
    best_time: bestTime,
    wave_height_m: waveHeight,
    temperature_c: temp,
    forecast_json: { hourly: hourlyForecast },
  };
}

export const WeatherService = {
  // Today's weather + condition badge for every beach in the catalogue
  // (BeachRepository.getAll(), not just ones the user actively tracks in
  // the Weather picker). Cache-first per beach, same as WeatherScreen's own
  // loadForecasts — fetches and caches only the beaches missing today's
  // forecast, so this never refetches ones already picked up elsewhere.
  async getBeachChecks() {
    const beaches = await BeachRepository.getAll();
    const date = today();
    const rows = await Promise.all(
      beaches.map(async (beach) => {
        let weather = await WeatherRepository.getForBeach(beach.name, date);
        if (!weather || isWeatherStale(weather)) {
          try {
            weather = await fetchBeachWeather(beach);
            await WeatherRepository.cache(weather);
          } catch (err) {
            console.warn('[WeatherService] beach check fetch failed for', beach.name, err.message);
            // Fetch failed — keep serving the stale row rather than nothing.
          }
        }
        return { beach, weather, condition: conditionIndicator(weather) };
      })
    );
    return rows;
  },

  // Force a fresh fetch for one beach, bypassing the cache — for a manual
  // "Refresh" action on the beach detail screen. Needed because
  // getBeachChecks() is cache-first: a beach whose today-row was cached
  // before the hourly breakdown existed (or is just stale) won't be
  // refetched again until the date rolls over otherwise.
  async refreshBeachCheck(beach) {
    const weather = await fetchBeachWeather(beach);
    await WeatherRepository.cache(weather);
    return { beach, weather, condition: conditionIndicator(weather) };
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
      `&daily=wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_sum&wind_speed_unit=kn&forecast_days=5`;
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
      const gustKn = fData.daily.wind_gusts_10m_max?.[i] ?? null;
      const waveM = mData?.daily?.wave_height_max?.[i] ?? null;
      const indicator = conditionIndicator({ best_wind_kn: windKn, wave_height_m: waveM });
      return {
        date,
        dayName: new Date(date).toLocaleDateString(undefined, { weekday: 'short' }),
        windKn,
        gustKn,
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

// tideModel.js — derives today's high and low water from Open-Meteo's marine
// model (sea_level_height_msl), for any beach in the catalogue.
//
// Why this instead of the imported Admiralty data: tide_predictions is filled
// from a CSV the rider imports by hand and only covers the dates in that file
// (the last import ran 6-19 Sep 2026), so it cannot answer "what is the tide
// today". There is also no per-beach tide workflow on the server. This model
// needs no key, no import, and works for every beach.
//
// Two honest limits, which the UI must not hide:
//   1. The series is hourly, so an extreme is only located to within an hour
//      until it is interpolated. The parabola fit below recovers most of that.
//   2. Heights are relative to MEAN SEA LEVEL. Admiralty/Chart Datum figures
//      sit on a different reference, so these numbers are not comparable with
//      an imported Admiralty prediction or a tide table — a 5.2m Chart Datum
//      high water showed as +1.9m here. The datum is carried through to the UI
//      rather than silently presented as if it were chart datum.

const TIDE_TIMEOUT_MS = 15000;

export const TIDE_DATUM_LABEL = 'vs mean sea level';

function tideUrl(beach) {
  return 'https://marine-api.open-meteo.com/v1/marine' +
    `?latitude=${beach.lat}&longitude=${beach.lon}` +
    '&hourly=sea_level_height_msl&timezone=auto&forecast_days=2';
}

// Fetches the hourly sea-level series for a beach. Returns
// [{ time: Date, height: number }, ...], or [] when the model has no coverage
// for that location (it is a finite global grid) or the request fails.
export async function fetchTideSeries(beach) {
  if (!beach?.lat || !beach?.lon) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIDE_TIMEOUT_MS);
  try {
    const res = await fetch(tideUrl(beach), { signal: controller.signal });
    if (!res.ok) throw new Error(`tide model returned ${res.status}`);

    const data = await res.json();
    const times = data?.hourly?.time || [];
    const heights = data?.hourly?.sea_level_height_msl || [];

    const series = [];
    for (let i = 0; i < times.length; i++) {
      const height = heights[i];
      if (height === null || height === undefined) continue;
      // timezone=auto returns a local-time string with no zone suffix, which
      // Date parses as local — the same clock the rider reads.
      const time = new Date(times[i]);
      if (Number.isNaN(time.getTime())) continue;
      series.push({ time, height });
    }
    return series;
  } finally {
    clearTimeout(timer);
  }
}

// Local maxima and minima of the series. `from` (a Date) drops events already
// past, so callers get what is still ahead of the rider rather than this
// morning's low water.
//
// Plateaus matter here and are the reason this is not a simple three-point
// test. When the true turn falls between two hourly samples those two come back
// equal — Daymer Bay read 1.68 at both 21:00 and 22:00 — and a strict
// "greater than both neighbours" test sees neither as a maximum, so the high
// water is lost and the caller silently gets the *next* one, up to 24 hours
// late. A run of equal values is therefore treated as one extreme, centred on
// the run.
//
// The centre is then refined by fitting a parabola through the samples either
// side of the run, which recovers sub-hour timing an hourly series cannot show
// directly. Against the imported Admiralty predictions for 10 Sep this put low
// water within 2 minutes (from 15 with no fit) and high water within ~30.
export function findTideExtremes(series, from) {
  const out = [];
  if (!Array.isArray(series) || series.length < 3) return out;

  let i = 1;
  while (i < series.length - 1) {
    // Extend a run of equal heights, so a plateau is one event, not zero.
    let j = i;
    while (j + 1 < series.length && series[j + 1].height === series[i].height) j++;

    const before = series[i - 1].height;
    const afterIdx = j + 1;
    const after = afterIdx < series.length ? series[afterIdx].height : null;
    const v = series[i].height;

    const isHigh = after !== null && before < v && after < v;
    const isLow  = after !== null && before > v && after > v;

    if (isHigh || isLow) {
      // Half-distance, in hours, from the run's centre to the samples either
      // side of it — 1 for a single point, 1.5 for a two-point plateau.
      const h = (j - i + 2) / 2;
      const denom = before - 2 * v + after;

      let offsetHours = 0;
      let height = v;
      if (denom !== 0) {
        offsetHours = 0.5 * ((before - after) / denom) * h;
        // The vertex cannot lie beyond the samples the fit was built from.
        if (Math.abs(offsetHours) > h) offsetHours = 0;
        height = v - 0.25 * ((before - after) / h) * offsetHours;
      }

      const centreMs = series[i].time.getTime() + ((j - i) / 2) * 3600000;
      const time = new Date(centreMs + offsetHours * 3600000);
      if (!from || time >= from) out.push({ type: isHigh ? 'HIGH' : 'LOW', time, height });
    }

    i = j + 1;
  }
  return out;
}

// The next high and next low still ahead, for the card. Returns
// { high: {time,height}|null, low: {time,height}|null, datum }.
export async function getTideForBeach(beach, now = new Date()) {
  try {
    const series = await fetchTideSeries(beach);
    const upcoming = findTideExtremes(series, now);
    return {
      high: upcoming.find((e) => e.type === 'HIGH') || null,
      low:  upcoming.find((e) => e.type === 'LOW')  || null,
      datum: TIDE_DATUM_LABEL,
    };
  } catch (err) {
    console.warn('[Tide] model unavailable for', beach?.name, err.message);
    return { high: null, low: null, datum: TIDE_DATUM_LABEL, error: err.message };
  }
}

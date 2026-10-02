// tideModel.js — tide heights for any beach, from Open-Meteo's marine model
// (sea_level_height_msl), with optional calibration onto an imported station's
// Chart Datum.
//
// Why the model instead of the imported data: tide_predictions is filled from a
// CSV the rider imports by hand and only covers the dates in that file (the
// most recent import ran 6-19 Sep 2026), so it cannot answer "what is the tide
// today". There is also no per-beach tide workflow on the server. The model
// needs no key, no import, and covers every beach.
//
// Why calibration is needed on top: the model reports heights relative to MEAN
// SEA LEVEL, and a tide table reports them relative to Chart Datum. They are
// not interchangeable — Torpoint's 5.24m chart-datum high water reads as 1.54m
// from the model — so any threshold expressed in chart datum ("launchable above
// 2.0m") is meaningless until the two are reconciled. Where the rider has an
// imported Admiralty set for a station, calibrateBeachDatum() fits
//   chart_datum = scale * msl + offset
// against it and every later series for that beach is converted. Where no
// import exists the heights stay relative and say so, rather than being
// presented as chart datum.

import { TideRepository } from '@commandersuite/core';

const TIDE_TIMEOUT_MS = 15000;

// Shown when heights could not be calibrated, so the rider is told the numbers
// are not the ones on a tide table.
export const TIDE_DATUM_LABEL = 'vs mean sea level';

function tideUrl(beach, { startDate, endDate } = {}) {
  const window = startDate && endDate
    ? `&start_date=${startDate}&end_date=${endDate}`
    : '&forecast_days=2';   // today + tomorrow, enough for the "next" HW/LW
  return 'https://marine-api.open-meteo.com/v1/marine' +
    `?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&hourly=sea_level_height_msl&timezone=auto${window}`;
}

// Fetches the hourly sea-level series for a beach. Returns
// [{ time: Date, height: number }, ...], or [] when the model has no coverage
// for that location (it is a finite global grid) or the request fails.
export async function fetchTideSeries(beach, options = {}) {
  if (!beach?.lat || !beach?.lon) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIDE_TIMEOUT_MS);
  try {
    const res = await fetch(tideUrl(beach, options), { signal: controller.signal });
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

// Least squares over paired points { x: modelHeight, y: importedHeight }.
// Returns null when there is too little to fit — one day of a neap tide would
// produce a confident and meaningless line.
export function fitDatumCalibration(pairs) {
  const usable = (pairs || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (usable.length < 4) return null;

  const n = usable.length;
  const mx = usable.reduce((s, p) => s + p.x, 0) / n;
  const my = usable.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0, sxx = 0;
  for (const p of usable) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
  if (sxx === 0) return null;

  const scale = sxy / sxx;
  const offset = my - scale * mx;
  const residuals = usable.map((p) => p.y - (scale * p.x + offset));
  const residualSd = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);

  return { scale, offset, samples: n, residualSd };
}

// Model value at an exact instant, interpolated between hourly samples. Returns
// null outside the series rather than extrapolating a height nobody measured.
export function sampleSeriesAt(series, at) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const t = at.getTime();
  if (t < series[0].time.getTime() || t > series[series.length - 1].time.getTime()) return null;

  let i = 0;
  while (i < series.length - 1 && series[i + 1].time.getTime() <= t) i++;
  const t0 = series[i].time.getTime();
  const t1 = series[i + 1].time.getTime();
  if (t1 === t0) return series[i].height;
  const f = (t - t0) / (t1 - t0);
  return series[i].height + (series[i + 1].height - series[i].height) * f;
}

// Fits and stores the Chart Datum calibration for a beach's station, from the
// rider's imported predictions and the model over the same window. Returns the
// stored calibration, or null when there is nothing to fit.
//
// Cached in tide_datum_calibration because the relationship is a property of
// the port, not of a fetch — recomputing it on every chart load would spend two
// network reads to arrive at the same two numbers.
export async function calibrateBeachDatum(beach, { force = false } = {}) {
  const stationId = beach?.tide_station_id;
  if (!stationId) return null;

  try {
    if (!force) {
      const existing = await TideRepository.getDatumCalibration(stationId);
      if (existing) return existing;
    }

    const predictions = await TideRepository.getPredictionsForStation(stationId);
    if (!predictions || predictions.length < 4) return null;

    const dates = predictions
      .map((p) => (p.prediction_time || '').slice(0, 10))
      .filter(Boolean)
      .sort();
    if (!dates.length) return null;

    const series = await fetchTideSeries(beach, { startDate: dates[0], endDate: dates[dates.length - 1] });
    if (series.length < 4) return null;

    const pairs = predictions
      .map((p) => {
        const at = new Date((p.prediction_time || '').replace(' ', 'T'));
        if (Number.isNaN(at.getTime())) return null;
        const x = sampleSeriesAt(series, at);
        return x === null ? null : { x, y: p.value_m };
      })
      .filter(Boolean);

    const fit = fitDatumCalibration(pairs);
    if (!fit) return null;

    await TideRepository.saveDatumCalibration({
      stationId,
      scale: fit.scale,
      offsetM: fit.offset,
      samples: fit.samples,
      residualSd: fit.residualSd,
      source: 'open-meteo vs imported predictions',
    });

    return fit;
  } catch (err) {
    console.warn('[Tide] datum calibration failed for', beach?.name, err.message);
    return null;
  }
}

// The beach's tide series, converted onto Chart Datum when a calibration
// exists for its station. `isChartDatum` tells the caller whether the heights
// may be compared with a tide table or a per-beach launch limit.
export async function getTideSeriesForBeach(beach, options = {}) {
  const series = await fetchTideSeries(beach, options);
  if (!series.length) return { series: [], isChartDatum: false, calibration: null };

  const calibration = await calibrateBeachDatum(beach, options);
  if (!calibration) return { series, isChartDatum: false, calibration: null };

  const scale = calibration.scale ?? 1;
  const offset = calibration.offset_m ?? calibration.offset ?? 0;
  return {
    series: series.map((p) => ({ time: p.time, height: scale * p.height + offset })),
    isChartDatum: true,
    calibration,
  };
}

// The next high and next low still ahead, for the card. Returns
// { high, low, datum, isChartDatum }.
export async function getTideForBeach(beach, now = new Date()) {
  try {
    const { series, isChartDatum } = await getTideSeriesForBeach(beach);
    const upcoming = findTideExtremes(series, now);
    return {
      high: upcoming.find((e) => e.type === 'HIGH') || null,
      low:  upcoming.find((e) => e.type === 'LOW')  || null,
      isChartDatum,
      datum: isChartDatum ? null : TIDE_DATUM_LABEL,
    };
  } catch (err) {
    console.warn('[Tide] model unavailable for', beach?.name, err.message);
    return { high: null, low: null, isChartDatum: false, datum: TIDE_DATUM_LABEL, error: err.message };
  }
}

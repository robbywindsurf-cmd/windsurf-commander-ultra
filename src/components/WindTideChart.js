// WindTideChart.js — wind and tide on one time axis, for a beach's day.
//
// Port of the Torpoint wind & tide chart mock to react-native-svg. Wind is the
// primary series against the left axis (kn); the tide overlays it on the right
// axis (m), so when the two line up is readable at a glance rather than by
// scanning a 16-row hourly list. HW/LW are pinned on the tide curve, a now-line
// marks the current time, and the window that is both windy enough and
// sailable is tinted.
//
// The prime band is only drawn when it can be judged honestly: it needs a
// per-beach launchable tide (minTideM) AND tide heights that are on the same
// datum as that limit. Heights that are still relative to mean sea level are
// not, so the band is withheld rather than computed against a threshold it
// cannot meet — a band that silently vanishes is less dangerous than one that
// silently says "go".
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, {
  Path, Line, Rect, Circle, Text as SvgText, G, Defs, LinearGradient, Stop,
} from 'react-native-svg';
import { colors } from '../theme';

const VIEW_W = 361;
const VIEW_H = 252;
const PAD = { top: 18, right: 32, bottom: 34, left: 30 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

const WIND_COLOUR = '#0284c7';
const TIDE_COLOUR = '#0d9488';
const PRIME_FILL = 'rgba(34,197,94,0.13)';
const PRIME_STROKE = 'rgba(22,163,74,0.35)';

// Catmull-Rom through the points, emitted as cubic beziers — the smooth curve
// the mock uses, rather than straight segments between hourly samples.
function smoothPath(points) {
  if (!points.length) return '';
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

// Value of a tide series at an instant, interpolated between hourly samples.
function sampleAt(series, at) {
  if (!series?.length) return null;
  const t = at.getTime();
  if (t < series[0].time.getTime() || t > series[series.length - 1].time.getTime()) return null;
  let i = 0;
  while (i < series.length - 1 && series[i + 1].time.getTime() <= t) i++;
  const t0 = series[i].time.getTime();
  const t1 = series[i + 1].time.getTime();
  if (t1 === t0) return series[i].height;
  return series[i].height + (series[i + 1].height - series[i].height) * ((t - t0) / (t1 - t0));
}

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

export default function WindTideChart({
  hourly = [],          // [{ time: 'HH:MM', wind_kn, wind_dir }] — the day's daylight hours
  tideSeries = [],      // [{ time: Date, height }]
  extremes = [],        // [{ type: 'HIGH'|'LOW', time: Date, height }]
  windIdealMin = null,
  windIdealMax = null,
  minTideM = null,
  isChartDatum = false,
  tideDatumLabel = null,
  now = new Date(),
  width = 340,
}) {
  const [selected, setSelected] = useState(null);

  const model = useMemo(() => {
    // The x axis is the wind series' own hours (the app stores 06:00-21:00),
    // falling back to the standard daylight window when there is no forecast.
    const hours = hourly.length
      ? hourly.map((h) => Number(String(h.time).slice(0, 2)))
      : Array.from({ length: 16 }, (_, i) => 6 + i).filter((h) => h <= 21);
    if (!hours.length) return null;

    const h0 = Math.min(...hours);
    const h1 = Math.max(...hours);
    const span = h1 - h0 || 1;

    const windVals = hourly.map((h) => h.wind_kn).filter((v) => v != null);
    const tideVals = hours
      .map((h) => sampleAt(tideSeries, new Date(now.getFullYear(), now.getMonth(), now.getDate(), h)))
      .filter((v) => v != null);

    const windMax = Math.max(6, Math.ceil((Math.max(...windVals, 0) * 1.15) / 2) * 2);
    const tideLo = tideVals.length ? Math.min(...tideVals) : 0;
    const tideHi = tideVals.length ? Math.max(...tideVals) : 1;
    const tideSpan = (tideHi - tideLo) || 1;

    const x = (h) => PAD.left + ((h - h0) / span) * PLOT_W;
    const wy = (v) => PAD.top + PLOT_H * (1 - v / windMax);
    // The tide axis is fitted to the day's own range rather than a fixed 0-6m,
    // so a neap day still fills the plot instead of hugging the bottom.
    const ty = (v) => PAD.top + PLOT_H * (1 - (v - tideLo) / tideSpan);

    const windPoints = hourly.map((h, i) => [x(hours[i]), wy(h.wind_kn ?? 0)]);
    const tidePoints = hours
      .map((h, i) => {
        const v = sampleAt(tideSeries, new Date(now.getFullYear(), now.getMonth(), now.getDate(), h));
        return v == null ? null : [x(h), ty(v)];
      })
      .filter(Boolean);

    const windPath = smoothPath(windPoints);
    const windArea = windPath && `${windPath} L ${x(h1)} ${PAD.top + PLOT_H} L ${x(h0)} ${PAD.top + PLOT_H} Z`;
    const tidePath = smoothPath(tidePoints);
    const tideArea = tidePath && `${tidePath} L ${x(h1)} ${PAD.top + PLOT_H} L ${x(h0)} ${PAD.top + PLOT_H} Z`;

    // Which hours qualify: windy enough AND with enough water. Withheld
    // entirely unless the tide can honestly be compared with the limit.
    const canJudge = minTideM != null && isChartDatum && windIdealMin != null && windIdealMax != null;
    const primeHours = [];
    if (canJudge) {
      for (const h of hours) {
        const i = hours.indexOf(h);
        const w = hourly[i]?.wind_kn;
        const t = sampleAt(tideSeries, new Date(now.getFullYear(), now.getMonth(), now.getDate(), h));
        if (w != null && t != null && w >= windIdealMin && w <= windIdealMax && t >= minTideM) {
          primeHours.push(h);
        }
      }
    }
    const primeFrom = primeHours.length ? Math.min(...primeHours) : null;
    const primeTo = primeHours.length ? Math.max(...primeHours) : null;

    const nowHour = now.getHours() + now.getMinutes() / 60;
    const nowInRange = nowHour >= h0 && nowHour <= h1;

    return {
      hours, h0, h1, x, wy, ty, windMax, tideLo, tideHi,
      windPath, windArea, tidePath, tideArea, windPoints,
      primeFrom, primeTo, canJudge, nowInRange, nowHour,
    };
  }, [hourly, tideSeries, minTideM, isChartDatum, windIdealMin, windIdealMax, now]);

  if (!model || !model.windPath) {
    return (
      <View style={[styles.placeholder, { width, height: 120 }]}>
        <Text style={styles.placeholderText}>No hourly forecast for today yet</Text>
      </View>
    );
  }

  const height = Math.round((width * VIEW_H) / VIEW_W);
  const { x, wy, ty, windMax, tideLo, tideHi, h0, h1, hours, nowHour, nowInRange } = model;

  const onTouch = (evt) => {
    const px = evt.nativeEvent.locationX;
    if (px == null) return;
    const viewX = (px / width) * VIEW_W;
    const frac = (viewX - PAD.left) / PLOT_W;
    if (frac < -0.05 || frac > 1.05) { setSelected(null); return; }
    const hour = Math.round(h0 + frac * (h1 - h0));
    if (hour < h0 || hour > h1) { setSelected(null); return; }
    setSelected(hour);
  };

  const selIdx = selected == null ? -1 : hours.indexOf(selected);
  const selHourly = selIdx >= 0 ? hourly[selIdx] : null;
  const selTide = selected == null ? null
    : sampleAt(tideSeries, new Date(now.getFullYear(), now.getMonth(), now.getDate(), selected));

  const windTicks = [0, windMax / 3, (2 * windMax) / 3, windMax].map((v) => Math.round(v));
  const tideTicks = [tideLo, (tideLo + tideHi) / 2, tideHi];

  return (
    <View style={{ width }}>
      <View
        style={{ width, height }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onTouch}
        onResponderMove={onTouch}
        onResponderRelease={() => setSelected(null)}
        onResponderTerminate={() => setSelected(null)}
      >
        <Svg width={width} height={height} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
          <Defs>
            <LinearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={WIND_COLOUR} stopOpacity="0.28" />
              <Stop offset="1" stopColor={WIND_COLOUR} stopOpacity="0.03" />
            </LinearGradient>
            <LinearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={TIDE_COLOUR} stopOpacity="0.16" />
              <Stop offset="1" stopColor={TIDE_COLOUR} stopOpacity="0.02" />
            </LinearGradient>
          </Defs>

          <Rect x={PAD.left} y={PAD.top} width={PLOT_W} height={PLOT_H} fill="rgba(255,255,255,0.03)" rx="8" />

          {model.primeFrom != null && (
            <Rect
              x={x(model.primeFrom - 0.4)}
              y={PAD.top}
              width={Math.max(x(model.primeTo + 0.4) - x(model.primeFrom - 0.4), 3)}
              height={PLOT_H}
              fill={PRIME_FILL}
              stroke={PRIME_STROKE}
              strokeDasharray="3 3"
              rx="8"
            />
          )}

          {windTicks.map((v) => (
            <G key={`w${v}`}>
              <Line x1={PAD.left} y1={wy(v)} x2={PAD.left + PLOT_W} y2={wy(v)}
                stroke="rgba(255,255,255,0.10)" strokeWidth="1" />
              <SvgText x={PAD.left - 5} y={wy(v) + 3.5} textAnchor="end" fontSize="9" fill="rgba(205,232,240,0.5)">{v}</SvgText>
            </G>
          ))}
          {tideTicks.map((v, i) => (
            <SvgText key={`t${i}`} x={PAD.left + PLOT_W + 5} y={ty(v) + 3.5} fontSize="9" fill="rgba(205,232,240,0.5)">
              {v.toFixed(1)}
            </SvgText>
          ))}

          {/* Tide behind, then wind in front — the mock's layer order. */}
          {!!tideArea && <Path d={tideArea} fill="url(#tg)" />}
          {!!model.tidePath && <Path d={model.tidePath} fill="none" stroke={TIDE_COLOUR} strokeWidth="2" />}

          {extremes.map((e, i) => {
            const px = x(e.time.getHours() + e.time.getMinutes() / 60);
            const py = ty(e.height);
            const isHigh = e.type === 'HIGH';
            return (
              <G key={`x${i}`}>
                <Circle cx={px} cy={py} r={isHigh ? 4.5 : 3.5}
                  fill={isHigh ? TIDE_COLOUR : colors.deep} stroke={TIDE_COLOUR} strokeWidth="2" />
                <SvgText x={px} y={py + (isHigh ? -9 : 16)} textAnchor="middle" fontSize="9" fontWeight="700" fill="#5eead4">
                  {`${isHigh ? 'HW' : 'LW'} ${hhmm(e.time)}`}
                </SvgText>
              </G>
            );
          })}

          {!!model.windArea && <Path d={model.windArea} fill="url(#wg)" />}
          <Path d={model.windPath} fill="none" stroke={WIND_COLOUR} strokeWidth="2.5" strokeLinecap="round" />
          {model.windPoints.map((p, i) => (
            <Circle key={`p${i}`} cx={p[0]} cy={p[1]} r="2.6" fill={colors.deep} stroke={WIND_COLOUR} strokeWidth="2" />
          ))}

          {nowInRange && (
            <G>
              <Line x1={x(nowHour)} y1={PAD.top} x2={x(nowHour)} y2={PAD.top + PLOT_H}
                stroke="#fff" strokeWidth="1" strokeDasharray="4 3" opacity="0.55" />
              <Rect x={x(nowHour) - 13} y={PAD.top - 12} width="26" height="12" rx="6" fill="#fff" opacity="0.85" />
              <SvgText x={x(nowHour)} y={PAD.top - 3} textAnchor="middle" fontSize="8" fontWeight="700" fill={colors.deep}>NOW</SvgText>
            </G>
          )}

          {hours.filter((h) => h % 3 === 0).map((h) => {
            const i = hours.indexOf(h);
            const dir = hourly[i]?.wind_dir;
            return (
              <G key={`a${h}`}>
                <SvgText x={x(h)} y={PAD.top + PLOT_H + 14} textAnchor="middle" fontSize="9.5" fill="rgba(205,232,240,0.55)">
                  {pad2(h)}
                </SvgText>
                {dir != null && (
                  <G transform={`translate(${x(h)},${PAD.top + PLOT_H + 22}) rotate(${dir})`}>
                    <Path d="M0,-4.2 L0,4.2 M0,4.2 L-2.2,2 M0,4.2 L2.2,2"
                      stroke={WIND_COLOUR} strokeWidth="1.4" fill="none" strokeLinecap="round" />
                  </G>
                )}
              </G>
            );
          })}

          {selected != null && (
            <Line x1={x(selected)} y1={PAD.top} x2={x(selected)} y2={PAD.top + PLOT_H}
              stroke={colors.accent} strokeWidth="1.4" opacity="0.9" />
          )}
        </Svg>
      </View>

      {/* The mock's tooltip, as a fixed readout row: a floating bubble has to be
          flipped near the right edge on a phone, and a row stays legible. */}
      <View style={styles.readout}>
        {selected == null || !selHourly ? (
          <Text style={styles.readoutHint}>Tap the chart for hourly detail</Text>
        ) : (
          <>
            <Text style={styles.readoutTime}>{pad2(selected)}:00</Text>
            <Text style={styles.readoutText}>
              💨 {selHourly.wind_kn != null ? `${selHourly.wind_kn.toFixed(1)}kn` : '—'}
              {selHourly.wind_dir != null ? ` ${selHourly.wind_dir}°` : ''}
              {selHourly.gust_kn != null ? ` (g${selHourly.gust_kn.toFixed(0)})` : ''}
            </Text>
            <Text style={styles.readoutText}>
              🌊 {selTide != null ? `${selTide.toFixed(2)}m` : '—'}
              {minTideM != null && isChartDatum && selTide != null
                ? (selTide >= minTideM ? ' · above launch limit' : ' · below launch limit')
                : ''}
            </Text>
          </>
        )}
      </View>

      <View style={styles.legend}>
        <Text style={styles.legendItem}>▬ Wind (kn)</Text>
        <Text style={styles.legendItemTeal}>▬ Tide (m)</Text>
        {model.canJudge && <Text style={styles.legendItemPrime}>▨ Prime window</Text>}
      </View>

      {!isChartDatum && (
        <Text style={styles.datumNote}>
          Tide heights are {tideDatumLabel || 'relative'}, not chart datum — import a tide set for this
          station to compare them with the launch limit.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: 'rgba(205,232,240,0.4)', fontSize: 13 },
  readout: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, minHeight: 24, flexWrap: 'wrap' },
  readoutHint: { color: 'rgba(205,232,240,0.35)', fontSize: 11 },
  readoutTime: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  readoutText: { color: 'rgba(205,232,240,0.8)', fontSize: 12 },
  legend: { flexDirection: 'row', gap: 12, paddingTop: 6, flexWrap: 'wrap' },
  legendItem: { color: WIND_COLOUR, fontSize: 10.5, fontWeight: '600' },
  legendItemTeal: { color: '#5eead4', fontSize: 10.5, fontWeight: '600' },
  legendItemPrime: { color: '#4ade80', fontSize: 10.5, fontWeight: '600' },
  datumNote: { color: 'rgba(205,232,240,0.4)', fontSize: 10.5, paddingTop: 6, lineHeight: 15 },
});

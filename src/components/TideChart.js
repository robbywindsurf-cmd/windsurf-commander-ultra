import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Line, Rect, Text as SvgText } from 'react-native-svg';
import { colors } from '../theme';

const PADDING = { top: 20, right: 12, bottom: 24, left: 38 };
const Y_AXIS_TICKS = 3;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Line chart of the tide curve for a session's date — time on the X axis,
 * height (m) on the Y axis with a labelled scale, and the session's own
 * start→end window shaded on top. Just the line — no per-point markers.
 */
export default function TideChart({ predictions, sessionStart, sessionEnd, tideStateAtStart, width = 340, height = 200 }) {
  if (!predictions || predictions.length < 2) {
    return (
      <View style={[styles.placeholder, { width, height }]}>
        <Text style={styles.placeholderText}>No tide data for this date</Text>
      </View>
    );
  }

  const chartW = width - PADDING.left - PADDING.right;
  const chartH = height - PADDING.top - PADDING.bottom;

  const times = predictions.map((p) => new Date(p.prediction_time).getTime());
  const values = predictions.map((p) => p.value_m);
  // X axis always spans the full 24h day, not just the range the data
  // happens to cover, so the timeline reads consistently across sessions.
  const minT = startOfDay(times[0]);
  const maxT = minT + 24 * 60 * 60 * 1000;
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const vRange = maxV - minV || 1;

  const x = (t) => PADDING.left + ((t - minT) / (maxT - minT || 1)) * chartW;
  const y = (v) => PADDING.top + chartH - ((v - minV) / vRange) * chartH;

  const points = predictions.map((p) => ({
    ...p,
    cx: x(new Date(p.prediction_time).getTime()),
    cy: y(p.value_m),
  }));
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.cx.toFixed(1)} ${p.cy.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${points[points.length - 1].cx.toFixed(1)} ${PADDING.top + chartH} L ${points[0].cx.toFixed(1)} ${PADDING.top + chartH} Z`;

  const startT = sessionStart ? new Date(sessionStart).getTime() : null;
  const endT = sessionEnd ? new Date(sessionEnd).getTime() : null;
  const showWindow = startT != null && endT != null && !Number.isNaN(startT) && !Number.isNaN(endT);

  const yTicks = Array.from({ length: Y_AXIS_TICKS }, (_, i) => minV + (vRange * i) / (Y_AXIS_TICKS - 1));

  return (
    <View>
      {tideStateAtStart && (
        <Text style={styles.stateText}>
          At session start: {tideStateAtStart.value_m}m — {tideStateAtStart.description}
        </Text>
      )}
      <Svg width={width} height={height}>
        {/* Y-axis height gridlines + labels */}
        {yTicks.map((v, i) => {
          const ty = y(v);
          return (
            <React.Fragment key={i}>
              <Line
                x1={PADDING.left} y1={ty} x2={PADDING.left + chartW} y2={ty}
                stroke="rgba(205,232,240,0.1)" strokeWidth={1}
              />
              <SvgText x={PADDING.left - 6} y={ty + 3} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="end">
                {v.toFixed(1)}m
              </SvgText>
            </React.Fragment>
          );
        })}

        {showWindow && (
          <Rect
            x={x(Math.max(startT, minT))}
            y={PADDING.top}
            width={Math.max(0, x(Math.min(endT, maxT)) - x(Math.max(startT, minT)))}
            height={chartH}
            fill="rgba(240,165,0,0.15)"
          />
        )}

        <Path d={areaD} fill="rgba(26,138,181,0.15)" stroke="none" />
        <Path d={pathD} stroke={colors.accent} strokeWidth={2} fill="none" />

        <SvgText x={PADDING.left} y={height - 4} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="start">
          00:00
        </SvgText>
        <SvgText x={PADDING.left + chartW / 2} y={height - 4} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="middle">
          12:00
        </SvgText>
        <SvgText x={PADDING.left + chartW} y={height - 4} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="end">
          24:00
        </SvgText>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    alignItems: 'center', justifyContent: 'center', borderRadius: 12,
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.15)',
  },
  placeholderText: { color: 'rgba(205,232,240,0.4)', fontSize: 13 },
  stateText: { color: colors.text, fontSize: 12, marginBottom: 6 },
});

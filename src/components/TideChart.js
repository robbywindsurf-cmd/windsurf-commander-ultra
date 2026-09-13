import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Line, Circle, Rect, Text as SvgText } from 'react-native-svg';
import { colors } from '../theme';

const PADDING = { top: 24, right: 16, bottom: 24, left: 34 };

function timeLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Simple SVG tide curve for a session's date. Plots the full day's
 * predictions (so high/low points outside the session window are still
 * visible), and shades the session's own start→end window on top of it.
 */
export default function TideChart({ predictions, sessionStart, sessionEnd, tideStateAtStart, width = 340, height = 180 }) {
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
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const vRange = maxV - minV || 1;

  const x = (t) => PADDING.left + ((t - minT) / (maxT - minT || 1)) * chartW;
  const y = (v) => PADDING.top + chartH - ((v - minV) / vRange) * chartH;

  const points = predictions.map((p) => ({ ...p, cx: x(new Date(p.prediction_time).getTime()), cy: y(p.value_m) }));
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.cx} ${p.cy}`).join(' ');

  const startT = sessionStart ? new Date(sessionStart).getTime() : null;
  const endT = sessionEnd ? new Date(sessionEnd).getTime() : null;
  const showWindow = startT != null && endT != null && !Number.isNaN(startT) && !Number.isNaN(endT);

  return (
    <View>
      {tideStateAtStart && (
        <Text style={styles.stateText}>
          At session start: {tideStateAtStart.value_m}m — {tideStateAtStart.description}
        </Text>
      )}
      <Svg width={width} height={height}>
        {/* Baseline */}
        <Line
          x1={PADDING.left} y1={PADDING.top + chartH}
          x2={PADDING.left + chartW} y2={PADDING.top + chartH}
          stroke="rgba(205,232,240,0.2)" strokeWidth={1}
        />

        {showWindow && (
          <Rect
            x={x(Math.max(startT, minT))}
            y={PADDING.top}
            width={Math.max(0, x(Math.min(endT, maxT)) - x(Math.max(startT, minT)))}
            height={chartH}
            fill="rgba(240,165,0,0.15)"
          />
        )}

        <Path d={pathD} stroke={colors.accent} strokeWidth={2} fill="none" />

        {points.map((p, i) => (
          <Circle key={i} cx={p.cx} cy={p.cy} r={3.5} fill={colors.deep} stroke={colors.accent} strokeWidth={1.5} />
        ))}
        {points.map((p, i) => (
          <SvgText
            key={`label-${i}`}
            x={p.cx}
            y={p.tide_type === 'high' ? p.cy - 8 : p.cy + 16}
            fontSize={10}
            fill={colors.text}
            textAnchor="middle"
          >
            {p.tide_type ? `${p.tide_type === 'high' ? 'H' : 'L'} ${p.value_m}m` : `${p.value_m}m`}
          </SvgText>
        ))}

        <SvgText x={PADDING.left} y={height - 4} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="start">
          {timeLabel(predictions[0].prediction_time)}
        </SvgText>
        <SvgText x={PADDING.left + chartW} y={height - 4} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="end">
          {timeLabel(predictions[predictions.length - 1].prediction_time)}
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

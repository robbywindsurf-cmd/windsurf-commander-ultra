import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Line, Text as SvgText } from 'react-native-svg';
import { colors } from '../theme';

const PADDING = { top: 16, right: 12, bottom: 22, left: 40 };

function dateLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** No-library SVG line chart of weight_log entries — dates on X, kg on Y. */
export default function WeightTrendChart({ entries, width = 340, height = 180 }) {
  if (!entries || entries.length < 2) return null;

  const chartW = width - PADDING.left - PADDING.right;
  const chartH = height - PADDING.top - PADDING.bottom;

  const times = entries.map((e) => new Date(e.logged_at).getTime());
  const weights = entries.map((e) => e.weight_kg);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const minW = Math.min(...weights);
  const maxW = Math.max(...weights);
  const wRange = maxW - minW || 1;

  const x = (t) => PADDING.left + ((t - minT) / (maxT - minT || 1)) * chartW;
  const y = (w) => PADDING.top + chartH - ((w - minW) / wRange) * chartH;

  const points = entries.map((e) => ({ cx: x(new Date(e.logged_at).getTime()), cy: y(e.weight_kg) }));
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.cx.toFixed(1)} ${p.cy.toFixed(1)}`).join(' ');

  const avgW = weights.reduce((a, b) => a + b, 0) / weights.length;

  return (
    <View>
      <Svg width={width} height={height}>
        <Line x1={PADDING.left} y1={y(minW)} x2={PADDING.left + chartW} y2={y(minW)} stroke="rgba(205,232,240,0.15)" strokeWidth={1} />
        <SvgText x={PADDING.left - 6} y={y(maxW) + 3} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="end">{maxW.toFixed(1)}kg</SvgText>
        <SvgText x={PADDING.left - 6} y={y(minW) + 3} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="end">{minW.toFixed(1)}kg</SvgText>

        <Path d={pathD} stroke={colors.accent} strokeWidth={2} fill="none" />

        <SvgText x={PADDING.left} y={height - 4} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="start">
          {dateLabel(entries[0].logged_at)}
        </SvgText>
        <SvgText x={PADDING.left + chartW} y={height - 4} fontSize={9} fill="rgba(205,232,240,0.4)" textAnchor="end">
          {dateLabel(entries[entries.length - 1].logged_at)}
        </SvgText>
      </Svg>
      <View style={styles.summaryRow}>
        <Text style={styles.summaryText}>{entries.length} readings</Text>
        <Text style={styles.summaryText}>Min {minW.toFixed(1)}kg</Text>
        <Text style={styles.summaryText}>Max {maxW.toFixed(1)}kg</Text>
        <Text style={styles.summaryText}>Avg {avgW.toFixed(1)}kg</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
  summaryText: { color: 'rgba(205,232,240,0.5)', fontSize: 11 },
});

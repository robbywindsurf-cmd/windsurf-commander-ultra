import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../theme';

/**
 * Peer comparison for the rider's biometric category.
 *
 * Numbers only, straight from the cached `category_summaries` row — no AI, so
 * nothing here can be fabricated and it costs no prompt budget. The AI prompt
 * used to carry a PEER COMPARISON block for this; that has been removed.
 *
 * Two things the wording has to get right:
 *  - The server widens a request to neighbouring bands when an exact 4-band key
 *    has too few riders, so `bandsMatched > 1` means these figures are *nearby*
 *    profiles, not the rider's exact band. Saying "similar riders" regardless
 *    would overstate the match.
 *  - Below the minimum sample count there is deliberately no comparison shown.
 *    A peer average built from three riders would look authoritative and be
 *    meaningless.
 */

function bandLabel(key) {
  if (!key) return null;
  const parts = key.split('_');
  const axis = (label, lo, hi, unit) => `${label} ${lo}-${hi}${unit}`;
  const out = [];
  if (parts[0] && parts[1]) out.push(axis('Height', parts[0].replace(/^[A-Z]+/, ''), parts[1], 'cm'));
  if (parts[2] && parts[3]) out.push(axis('Weight', parts[2].replace(/^[A-Z]+/, ''), parts[3], 'kg'));
  if (parts[4] && parts[5]) out.push(axis('Leg', parts[4].replace(/^[A-Z]+/, ''), parts[5], 'cm'));
  if (parts[6] && parts[7]) out.push(axis('Arm', parts[6].replace(/^[A-Z]+/, ''), parts[7], 'cm'));
  return out.length ? out.join(' · ') : key;
}

const num = (v, digits = 1, suffix = '') =>
  v == null || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(digits)}${suffix}`;

export default function PeerComparisonTable({ peer, personalBestKn }) {
  const status = peer?.status ?? 'unavailable';
  const row = peer?.row;
  const peak = peer?.yourPeak;

  const statusCard = (
    <View style={styles.container}>
      <Text style={styles.sectionLabel}>👥 Peer Comparison</Text>
      <View style={styles.card}>
        <Text style={styles.category}>{bandLabel(peer?.biometrics?.biometric_category) ?? 'Rider profile not set'}</Text>
        <Text style={styles.message}>{statusMessage(status, peer)}</Text>
      </View>
    </View>
  );

  if (status !== 'ready') return statusCard;

  const bandsMatched = row?.bands_matched ?? 1;
  const rows = [
    {
      label: 'Peak speed',
      you: num(personalBestKn, 1, 'kn'),
      peerAvg: num(row.avg_speed_kn, 1, 'kn'),
      peerBest: num(row.best_speed_kn, 1, 'kn'),
      emphasis: true,
    },
    {
      label: 'Back foot pressure',
      you: peak?.back_foot_pct != null ? `${Math.round(peak.back_foot_pct)}%` : '—',
      peerAvg: row.avg_back_foot_pct != null ? `${Math.round(row.avg_back_foot_pct)}%` : '—',
      peerBest: '—',
    },
    {
      label: 'Fin load (est)',
      you: peak?.fin_load_kg != null ? `~${Math.round(peak.fin_load_kg)}kg` : '—',
      peerAvg: row.avg_fin_load_kg != null ? `~${Math.round(row.avg_fin_load_kg)}kg` : '—',
      peerBest: '—',
    },
    {
      label: 'Back knee angle',
      you: peak?.right_knee_angle != null ? `${Math.round(peak.right_knee_angle)}°` : '—',
      peerAvg: row.avg_back_knee_min != null && row.avg_back_knee_max != null
        ? `${Math.round(row.avg_back_knee_min)}-${Math.round(row.avg_back_knee_max)}°`
        : '—',
      peerBest: '—',
    },
    {
      label: 'Common board',
      you: '—',
      peerAvg: row.common_board_vol_l != null ? `${Math.round(row.common_board_vol_l)}L` : '—',
      peerBest: '—',
    },
    {
      label: 'Common fin',
      you: '—',
      peerAvg: row.common_fin_size_cm != null ? `${Math.round(row.common_fin_size_cm)}cm` : '—',
      peerBest: '—',
    },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.sectionLabel}>👥 Peer Comparison</Text>
      <View style={styles.card}>
        <Text style={styles.category}>{bandLabel(peer?.biometrics?.biometric_category)}</Text>
        <Text style={styles.sampleCount}>
          {bandsMatched > 1
            ? `${row.sample_count} riders in nearby profile bands`
            : `${row.sample_count} riders in your profile band`}
        </Text>

        <View style={styles.headerRow}>
          <Text style={[styles.col, styles.colLabel, styles.headerText]}>Metric</Text>
          <Text style={[styles.col, styles.colYou, styles.headerText]}>You</Text>
          <Text style={[styles.col, styles.colNum, styles.headerText]}>Peer avg</Text>
          <Text style={[styles.col, styles.colNum, styles.headerText]}>Peer best</Text>
        </View>

        {rows.map((r, i) => (
          <View key={r.label} style={[styles.row, i % 2 === 0 && styles.rowAlt]}>
            <Text style={[styles.col, styles.colLabel]}>{r.label}</Text>
            <Text style={[styles.col, styles.colYou, r.emphasis && styles.emphasisText]}>{r.you}</Text>
            <Text style={[styles.col, styles.colNum]}>{r.peerAvg}</Text>
            <Text style={[styles.col, styles.colNum, styles.bestText]}>{r.peerBest}</Text>
          </View>
        ))}

        <Text style={styles.footer}>
          {bandsMatched > 1
            ? `Peers are similar riders from your band and the bands next to it. Your figures are from your most recent peak-speed frame; peer averages are built the same way.`
            : `Your figures are from your most recent peak-speed frame; peer averages are built the same way.`}
        </Text>
        <Text style={styles.footer}>
          ⚠️ Peer data is anonymised aggregates. Biomechanics figures are estimates from body position.
        </Text>
        {row.fetched_at ? <Text style={styles.updated}>Fetched {String(row.fetched_at).slice(0, 10)}</Text> : null}
      </View>
    </View>
  );
}

function statusMessage(status, peer) {
  if (status === 'no-profile') return 'Add your height, weight, inside leg and arm span in Settings → Rider Profile to compare against similar riders.';
  if (status === 'building') {
    const n = peer?.sampleCount ?? 0;
    const min = peer?.minimum ?? 10;
    return `Building dataset — ${n} of ${min} similar riders so far. Peers appear once enough riders in your profile band have used the app.`;
  }
  if (status === 'unavailable') return `Peer comparison unavailable${peer?.reason ? ` (${peer.reason})` : ''}. It will retry next time this screen loads.`;
  return 'No peer data yet.';
}

const styles = StyleSheet.create({
  container: { marginTop: 6 },
  sectionLabel: {
    color: 'rgba(205,232,240,0.5)', fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8, marginTop: 18,
  },
  card: {
    backgroundColor: 'rgba(26,138,181,0.08)', borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: 'rgba(26,138,181,0.2)',
  },
  category: { color: colors.accent, fontSize: 12, marginBottom: 4 },
  sampleCount: { color: 'rgba(205,232,240,0.55)', fontSize: 12, marginBottom: 14 },
  message: { color: 'rgba(205,232,240,0.7)', fontSize: 13, lineHeight: 20 },

  headerRow: {
    flexDirection: 'row', paddingBottom: 8, marginBottom: 4,
    borderBottomWidth: 1, borderBottomColor: 'rgba(26,138,181,0.2)',
  },
  row: { flexDirection: 'row', paddingVertical: 6 },
  rowAlt: { backgroundColor: 'rgba(26,138,181,0.05)' },
  headerText: { fontSize: 10, fontWeight: '700', color: 'rgba(205,232,240,0.5)', textTransform: 'uppercase' },
  col: { fontSize: 12, color: colors.text },
  colLabel: { flex: 2.2 },
  colYou: { flex: 1, textAlign: 'center', fontWeight: '600' },
  colNum: { flex: 1, textAlign: 'center', color: 'rgba(205,232,240,0.6)' },
  emphasisText: { color: colors.amber, fontWeight: '700' },
  bestText: { color: colors.amber },

  footer: { color: 'rgba(205,232,240,0.4)', fontSize: 10, lineHeight: 14, marginTop: 10 },
  updated: { color: 'rgba(205,232,240,0.3)', fontSize: 10, marginTop: 4 },
});

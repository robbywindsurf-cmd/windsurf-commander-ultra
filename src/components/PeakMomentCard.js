import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';

const DEEP = '#061f2e';
const SKY = '#1a8ab5';
const GOLD = '#f0a500';
const TEXT = '#cde8f0';
const DIVIDER = 'rgba(26,138,181,0.3)';
const WATERMARK = 'rgba(205,232,240,0.2)';

const CARD_WIDTH = 390;
const CARD_HEIGHT = 690;

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Fixed-size (390x690) shareable card — designed to be wrapped in a
 * react-native-view-shot <ViewShot> by the screen and captured as an image.
 * `tier` controls the watermark: free shows it, premium/ultimate don't;
 * ultimate additionally shows a video badge when a video clip is attached.
 */
export default function PeakMomentCard({ peakMoment, tier = 'free', hasVideoClip = false }) {
  const p = peakMoment;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.headerText}>🏄 WINDSURF COMMANDER ULTRA</Text>
      </View>

      <View style={styles.imageArea}>
        {p.skeletonFrame ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${p.skeletonFrame}` }}
            style={styles.frameImage}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.framePlaceholder}>
            <Text style={styles.framePlaceholderEmoji}>🌊</Text>
            <Text style={styles.framePlaceholderText}>No video</Text>
          </View>
        )}
        {tier === 'ultimate' && hasVideoClip && (
          <View style={styles.videoBadge}>
            <Text style={styles.videoBadgeText}>🎬 VIDEO</Text>
          </View>
        )}
      </View>

      <View style={styles.body}>
        <Text style={styles.peakSpeed}>⚡ {p.peakSpeedKn != null ? p.peakSpeedKn.toFixed(2) : '—'} kn</Text>
        <Text style={styles.metaLine}>📅 {formatDate(p.date)}</Text>
        <Text style={styles.metaLine}>📍 {p.beachName || 'Unknown location'}</Text>

        <View style={styles.divider} />

        <Text style={styles.metaLine}>
          💨 {p.windKn != null ? `${Math.round(p.windKn)}kn` : '—'} {p.windDir || ''}
        </Text>
        <Text style={styles.metaLine}>🌊 {p.waveHeightM != null ? `${p.waveHeightM}m swell` : '—'}</Text>
        <Text style={styles.metaLine}>🌡️ {p.tempC != null ? `${Math.round(p.tempC)}°C` : '—'}</Text>
        {p.tideM != null && (
          <Text style={styles.metaLine}>🌊 Tide: {p.tideM}m {p.tideDescription || ''}</Text>
        )}

        <View style={styles.divider} />

        <Text style={styles.gearLine}>
          🏄 {[p.boardName, p.sailName && `${p.sailName}${p.sailSize ? ` ${p.sailSize}m` : ''}`].filter(Boolean).join(' + ') || 'Gear not logged'}
        </Text>

        {(p.frontLegDesc || p.backLegDesc || p.hr) && (
          <>
            {p.frontLegDesc && <Text style={styles.bioLine}>Front leg: {p.frontLegDesc}</Text>}
            {p.backLegDesc && <Text style={styles.bioLine}>Back leg: {p.backLegDesc}</Text>}
            {p.hr && <Text style={styles.bioLine}>❤️ {p.hr} bpm</Text>}
          </>
        )}

        <View style={styles.divider} />

        {tier === 'free' && (
          <Text style={styles.watermark}>Created with Windsurf Commander Ultra</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    backgroundColor: DEEP,
    overflow: 'hidden',
  },
  header: {
    backgroundColor: SKY,
    paddingVertical: 14,
    alignItems: 'center',
  },
  headerText: { color: '#fff', fontWeight: '800', fontSize: 14, letterSpacing: 1 },

  imageArea: { width: CARD_WIDTH, height: 280, backgroundColor: '#03141e' },
  frameImage: { width: '100%', height: '100%' },
  framePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  framePlaceholderEmoji: { fontSize: 40, marginBottom: 6 },
  framePlaceholderText: { color: 'rgba(205,232,240,0.4)', fontSize: 13 },
  videoBadge: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(6,31,46,0.85)', borderWidth: 1, borderColor: GOLD,
    borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8,
  },
  videoBadgeText: { color: GOLD, fontSize: 11, fontWeight: '700' },

  body: { padding: 20, flex: 1 },

  peakSpeed: { color: GOLD, fontSize: 48, fontWeight: '900', marginBottom: 6 },
  metaLine: { color: TEXT, fontSize: 14, marginBottom: 4 },
  gearLine: { color: TEXT, fontSize: 14, marginBottom: 4 },
  bioLine: { color: TEXT, fontSize: 13, marginBottom: 3 },

  divider: { height: 1, backgroundColor: DIVIDER, marginVertical: 12 },

  watermark: { color: WATERMARK, fontSize: 11, textAlign: 'center', marginTop: 4 },
});

export { CARD_WIDTH, CARD_HEIGHT };

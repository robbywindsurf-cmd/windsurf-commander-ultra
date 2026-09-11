import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SessionRepository, TierService } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { colors } from '../theme';

function formatDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function HomeScreen() {
  const [bests, setBests] = useState(null);
  const [recent, setRecent] = useState([]);
  const [tier, setTier] = useState('free');

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [b, r, t] = await Promise.all([
            SessionRepository.getPersonalBests(),
            SessionRepository.getRecentSessions(5),
            TierService.getCachedTier(),
          ]);
          if (cancelled) return;
          setBests(b);
          setRecent(r);
          setTier(t);
        } catch (err) {
          console.warn('[Home] load error:', err.message);
        }
      })();
      return () => { cancelled = true; };
    }, [])
  );

  return (
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={`${tier.toUpperCase()} TIER`} title="🏄 Windsurf Commander" />

      <Text style={styles.sectionLabel}>Personal Bests</Text>
      <View style={styles.statsRow}>
        <SharedCard style={styles.statCard}>
          <Text style={styles.statValue}>{bests?.best_speed ? bests.best_speed.toFixed(1) : '—'}</Text>
          <Text style={styles.statLabel}>kn top speed</Text>
        </SharedCard>
        <SharedCard style={styles.statCard}>
          <Text style={styles.statValue}>{bests?.total_sessions ?? 0}</Text>
          <Text style={styles.statLabel}>sessions logged</Text>
        </SharedCard>
        <SharedCard style={styles.statCard}>
          <Text style={styles.statValue}>{formatDuration(bests?.total_time_s)}</Text>
          <Text style={styles.statLabel}>total time</Text>
        </SharedCard>
      </View>

      <Text style={styles.sectionLabel}>Recent Sessions</Text>
      {recent.length === 0 ? (
        <Text style={styles.emptyText}>No sessions logged yet.</Text>
      ) : (
        recent.map((s) => (
          <SharedCard key={s.session_id}>
            <Text style={styles.sessionTitle}>{s.date} {s.start_time ? `· ${s.start_time}` : ''}</Text>
            <Text style={styles.sessionMeta}>
              {s.max_speed_kn ? `${s.max_speed_kn.toFixed(1)} kn max` : 'No speed data'}
              {s.distance_m ? ` · ${(s.distance_m / 1000).toFixed(1)} km` : ''}
            </Text>
          </SharedCard>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  sectionLabel: {
    color: 'rgba(205,232,240,0.5)', fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8, marginTop: 16,
  },
  statsRow: { flexDirection: 'row', gap: 8 },
  statCard: { flex: 1, alignItems: 'center' },
  statValue: { color: colors.text, fontSize: 20, fontWeight: '800' },
  statLabel: { color: 'rgba(205,232,240,0.5)', fontSize: 11, marginTop: 2, textAlign: 'center' },
  sessionTitle: { color: colors.text, fontWeight: '600', fontSize: 14, marginBottom: 4 },
  sessionMeta: { color: 'rgba(205,232,240,0.5)', fontSize: 12 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },
});

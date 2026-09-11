import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SessionRepository, AnalysisRepository, TrackpointRepository, FeatureGate } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import SessionRouteMap from '../components/SessionRouteMap';
import { colors } from '../theme';

export default function SessionDetailScreen({ route, navigation }) {
  const { sessionId } = route.params;
  const [session, setSession] = useState(null);
  const [analyses, setAnalyses] = useState([]);
  const [trackpoints, setTrackpoints] = useState([]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [s, a, tp] = await Promise.all([
            SessionRepository.getById(sessionId),
            AnalysisRepository.getAnalysesForSession(sessionId),
            TrackpointRepository.getForSession(sessionId),
          ]);
          if (!cancelled) { setSession(s); setAnalyses(a); setTrackpoints(tp); }
        } catch (err) {
          console.warn('[SessionDetail] load error:', err.message);
        }
      })();
      return () => { cancelled = true; };
    }, [sessionId])
  );

  if (!session) {
    return (
      <View style={styles.scrollBg}>
        <Header title="Session" />
        <Text style={styles.emptyText}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={session.date} title="📅 Session Detail" />

      <SessionRouteMap trackpoints={trackpoints} height={340} />

      <SharedCard style={{ marginTop: 16 }}>
        <Text style={styles.row}>Max speed: {session.max_speed_kn ? `${session.max_speed_kn.toFixed(1)} kn` : '—'}</Text>
        <Text style={styles.row}>Avg speed: {session.avg_speed_kn ? `${session.avg_speed_kn.toFixed(1)} kn` : '—'}</Text>
        <Text style={styles.row}>Distance: {session.distance_m ? `${(session.distance_m / 1000).toFixed(1)} km` : '—'}</Text>
        <Text style={styles.row}>Duration: {session.duration_s ? `${Math.round(session.duration_s / 60)} min` : '—'}</Text>
      </SharedCard>

      <Text style={styles.sectionLabel}>Biomechanics Analyses</Text>
      {analyses.length === 0 ? (
        <Text style={styles.emptyText}>No video analyses for this session yet.</Text>
      ) : (
        analyses.map((a) => (
          <SharedCard key={a.id}>
            <Text style={styles.row}>Frames detected: {a.frames_detected}/{a.frames_total}</Text>
            <Text style={styles.row}>Knee L/R: {a.left_knee_avg ?? '—'}° / {a.right_knee_avg ?? '—'}°</Text>
            <Text style={styles.row}>Back angle: {a.back_angle_avg ?? '—'}°</Text>
          </SharedCard>
        ))
      )}

      <FeatureGate
        feature="COACHING_REPORT"
        onUpgradePress={() => navigation.navigate('Upgrade')}
      >
        <SharedCard>
          <Text style={styles.row}>AI coaching report available.</Text>
        </SharedCard>
      </FeatureGate>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { flex: 1, backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  sectionLabel: {
    color: 'rgba(205,232,240,0.5)', fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8, marginTop: 16,
  },
  row: { color: colors.text, fontSize: 13, marginBottom: 4 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },
});

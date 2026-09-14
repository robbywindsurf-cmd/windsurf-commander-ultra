import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, StyleSheet, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SessionRepository, AnalysisRepository, TrackpointRepository, TideRepository, WeatherRepository, UserStore, FeatureGate } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import SessionRouteMap from '../components/SessionRouteMap';
import TideChart from '../components/TideChart';
import { colors } from '../theme';

export default function SessionDetailScreen({ route, navigation }) {
  const { sessionId } = route.params;
  const [session, setSession] = useState(null);
  const [analyses, setAnalyses] = useState([]);
  const [trackpoints, setTrackpoints] = useState([]);
  const [tidePredictions, setTidePredictions] = useState([]);
  const [tideStateAtStart, setTideStateAtStart] = useState(null);
  const [weather, setWeather] = useState(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [s, a, tp] = await Promise.all([
            SessionRepository.getById(sessionId),
            AnalysisRepository.getAnalysesForSession(sessionId),
            TrackpointRepository.getSampledForSession(sessionId, 400),
          ]);
          if (cancelled) return;
          setSession(s); setAnalyses(a); setTrackpoints(tp);

          if (s?.date) {
            const startTimestamp = s.start_time ? `${s.date}T${s.start_time}` : s.date;
            const favouriteBeach = await UserStore.getFavouriteBeach();
            const [predictions, tideState, weatherRow] = await Promise.all([
              TideRepository.getPredictionsForDate(s.date),
              TideRepository.getTideStateAtTime(startTimestamp),
              favouriteBeach ? WeatherRepository.getForBeach(favouriteBeach.name, s.date) : null,
            ]);
            if (!cancelled) {
              setTidePredictions(predictions);
              setTideStateAtStart(tideState);
              setWeather(weatherRow);
            }
          }
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
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={session.date} title="📅 Session Detail" />

      <SessionRouteMap trackpoints={trackpoints} height={340} />

      <TouchableOpacity activeOpacity={0.7}
        style={styles.peakMomentBtn}
        onPress={() => navigation.navigate('PeakMoment', { sessionId })}
        accessibilityLabel="Create Peak Moment"
      >
        <Text style={styles.peakMomentBtnText}>🏆 Peak Moment</Text>
      </TouchableOpacity>

      <SharedCard style={{ marginTop: 16 }}>
        <Text style={styles.row}>Max speed: {session.max_speed_kn ? `${session.max_speed_kn.toFixed(1)} kn` : '—'}</Text>
        <Text style={styles.row}>Avg speed: {session.avg_speed_kn ? `${session.avg_speed_kn.toFixed(1)} kn` : '—'}</Text>
        <Text style={styles.row}>Distance: {session.distance_m ? `${(session.distance_m / 1000).toFixed(1)} km` : '—'}</Text>
        <Text style={styles.row}>Duration: {session.duration_s ? `${Math.round(session.duration_s / 60)} min` : '—'}</Text>
      </SharedCard>

      <Text style={styles.sectionLabel}>Weather</Text>
      <SharedCard>
        {weather ? (
          <>
            <Text style={styles.row}>📍 {weather.beach_name}</Text>
            <Text style={styles.row}>
              💨 {weather.best_wind_kn != null ? `${Math.round(weather.best_wind_kn)}kn` : '—'}
              {weather.best_wind_dir != null ? ` ${weather.best_wind_dir}°` : ''}
            </Text>
            <Text style={styles.row}>🌊 {weather.wave_height_m != null ? `${weather.wave_height_m}m swell` : '—'}</Text>
            <Text style={styles.row}>🌡️ {weather.temperature_c != null ? `${Math.round(weather.temperature_c)}°C` : '—'}</Text>
          </>
        ) : (
          <TouchableOpacity activeOpacity={0.7} onPress={() => navigation.navigate('ImportData')}>
            <Text style={styles.emptyText}>
              No weather data for this date — run "Backfill Historical Weather" from Import Data
            </Text>
          </TouchableOpacity>
        )}
      </SharedCard>

      <Text style={styles.sectionLabel}>Tide</Text>
      <SharedCard>
        <TideChart
          predictions={tidePredictions}
          sessionStart={session.start_time ? `${session.date}T${session.start_time}` : null}
          sessionEnd={session.end_time ? `${session.date}T${session.end_time}` : null}
          tideStateAtStart={tideStateAtStart}
          width={300}
        />
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
        onUpgradePress={() => navigation.navigate('Upgrade', { featureId: 'COACHING_REPORT' })}
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
  peakMomentBtn: {
    backgroundColor: '#f0a500', paddingVertical: 12, borderRadius: 12,
    alignItems: 'center', marginTop: 14,
  },
  peakMomentBtnText: { color: colors.deep, fontWeight: '800', fontSize: 14 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },
});

import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, StyleSheet, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SessionRepository, EquipmentRepository, AnalysisRepository, TrackpointRepository, TideRepository, WeatherRepository, UserStore, FeatureGate, WindEstimator, ManoeuvreDetector, AnalyticsService } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import SessionRouteMap from '../components/SessionRouteMap';
import TideChart from '../components/TideChart';
import { colors } from '../theme';
import { formatLocalTime } from '../utils/videoUtc';

export default function SessionDetailScreen({ route, navigation }) {
  const { sessionId } = route.params;
  const [session, setSession] = useState(null);
  const [gearCombo, setGearCombo] = useState(null);
  const [analyses, setAnalyses] = useState([]);
  const [coachingNotes, setCoachingNotes] = useState([]);
  const [expandedNoteId, setExpandedNoteId] = useState(null);
  const [trackpoints, setTrackpoints] = useState([]);
  const [tidePredictions, setTidePredictions] = useState([]);
  const [tideStateAtStart, setTideStateAtStart] = useState(null);
  const [weather, setWeather] = useState(null);
  const [sailingStats, setSailingStats] = useState(null); // { wind, manoeuvres, vmg } | null

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [s, a, tp, notes] = await Promise.all([
            SessionRepository.getById(sessionId),
            AnalysisRepository.getAnalysesForSession(sessionId),
            TrackpointRepository.getSampledForSession(sessionId, 400),
            AnalysisRepository.getCoachingNotes(sessionId),
          ]);
          if (cancelled) return;
          setSession(s); setAnalyses(a); setTrackpoints(tp); setCoachingNotes(notes);

          if (s?.gear_combo_id) {
            const combos = await EquipmentRepository.getGearCombos();
            if (!cancelled) setGearCombo(combos.find((c) => c.id === s.gear_combo_id) || null);
          } else {
            setGearCombo(null);
          }

          let weatherRow = null;
          if (s?.date) {
            const startTimestamp = s.start_time ? `${s.date}T${s.start_time}` : s.date;
            const favouriteBeach = await UserStore.getFavouriteBeach();
            const [predictions, tideState, wRow] = await Promise.all([
              TideRepository.getPredictionsForDate(s.date),
              TideRepository.getTideStateAtTime(startTimestamp),
              favouriteBeach ? WeatherRepository.getForBeach(favouriteBeach.name, s.date) : null,
            ]);
            weatherRow = wRow;
            if (!cancelled) {
              setTidePredictions(predictions);
              setTideStateAtStart(tideState);
              setWeather(weatherRow);
            }
          }

          // Full (unsampled) trackpoints for wind/manoeuvre/VMG estimation —
          // the 400-point sample above is for the route map, too sparse to
          // reliably catch short tacks/gybes.
          TrackpointRepository.getForSession(sessionId)
            .then((fullTp) => {
              if (cancelled) return;
              const wind = WindEstimator.estimateFromTrackpoints(fullTp);

              // Fall back to the beach's forecast wind direction (weather_cache,
              // via WeatherRepository) when the GPS estimate's confidence is
              // low/none — there's no per-session wind_direction column on
              // `sessions` itself, this is the same "stored" wind data the
              // Weather card above already displays.
              const windFromDeg = (wind.confidence === 'high' || wind.confidence === 'medium')
                ? wind.windFromDeg
                : weatherRow?.best_wind_dir ?? null;
              const windSource = (wind.confidence === 'high' || wind.confidence === 'medium')
                ? 'gps_estimated'
                : weatherRow?.best_wind_dir != null
                  ? 'stored'
                  : null;

              const manoeuvres = ManoeuvreDetector.detect(fullTp, windFromDeg);
              const vmgSamples = AnalyticsService.computeVMG(fullTp, windFromDeg);
              const vmg = AnalyticsService.summarizeVMG(vmgSamples);
              setSailingStats({ wind, windFromDeg, windSource, manoeuvres, vmg });
            })
            .catch((err) => console.warn('[SessionDetail] sailing analytics failed:', err.message));
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

      {gearCombo?.board_name && (
        <>
          <Text style={styles.sectionLabel}>Equipment</Text>
          <SharedCard>
            <Text style={styles.row}>
              🏄 Board: {gearCombo.board_brand ? gearCombo.board_brand + ' ' : ''}{gearCombo.board_name}
              {gearCombo.board_size ? ` ${gearCombo.board_size}${/[a-zA-Z]/.test(String(gearCombo.board_size)) ? '' : 'L'}` : ''}
            </Text>
            <Text style={styles.row}>
              ⛵ Sail: {gearCombo.sail_name
                ? `${gearCombo.sail_brand ? gearCombo.sail_brand + ' ' : ''}${gearCombo.sail_name}${gearCombo.sail_size != null ? ` ${gearCombo.sail_size}${/[a-zA-Z]/.test(String(gearCombo.sail_size)) ? '' : 'm²'}` : ''}`
                : '—'}
            </Text>
            {gearCombo.fin_name && (
              <Text style={styles.row}>
                Fin: {gearCombo.fin_name}
                {gearCombo.fin_size ? ` ${gearCombo.fin_size}${/[a-zA-Z]/.test(String(gearCombo.fin_size)) ? '' : 'cm'}` : ''}
              </Text>
            )}
            {!!gearCombo.notes && (
              <Text style={styles.disclaimerText}>{gearCombo.notes}</Text>
            )}
          </SharedCard>
        </>
      )}

      <Text style={styles.sectionLabel}>Weather</Text>
      <SharedCard>
        {weather ? (
          <>
            <Text style={styles.row}>📍 {weather.beach_name}</Text>
            <Text style={styles.row}>
              💨 {weather.best_wind_kn != null ? `${Math.round(weather.best_wind_kn)}kn` : '—'}
              {weather.best_gust_kn != null ? ` (gusts ${Math.round(weather.best_gust_kn)}kn)` : ''}
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

      <Text style={styles.sectionLabel}>Sailing Analytics (estimated)</Text>
      <SharedCard>
        {!sailingStats ? (
          <Text style={styles.emptyText}>No GPS data for this session.</Text>
        ) : sailingStats.windFromDeg == null ? (
          <Text style={styles.emptyText}>💨 No wind data available</Text>
        ) : (
          <>
            <Text style={styles.row}>
              {sailingStats.windSource === 'gps_estimated'
                ? `💨 GPS-derived (${sailingStats.wind.confidence} confidence): ${sailingStats.windFromDeg}°`
                : `💨 Stored from session data: ${sailingStats.windFromDeg}°`}
            </Text>
            <Text style={styles.row}>
              🔄 Tacks: {sailingStats.manoeuvres.tacks}  ·  Gybes: {sailingStats.manoeuvres.gybes}
              {sailingStats.manoeuvres.uncategorised ? `  ·  Other turns: ${sailingStats.manoeuvres.uncategorised}` : ''}
            </Text>
            <Text style={styles.row}>
              ⬆️ Best VMG upwind: {sailingStats.vmg.bestUpwindVMGKn != null ? `${sailingStats.vmg.bestUpwindVMGKn} kn` : '—'}
              {'  '}(avg {sailingStats.vmg.avgUpwindVMGKn != null ? `${sailingStats.vmg.avgUpwindVMGKn} kn` : '—'})
            </Text>
            <Text style={styles.row}>
              ⬇️ Best VMG downwind: {sailingStats.vmg.bestDownwindVMGKn != null ? `${sailingStats.vmg.bestDownwindVMGKn} kn` : '—'}
              {'  '}(avg {sailingStats.vmg.avgDownwindVMGKn != null ? `${sailingStats.vmg.avgDownwindVMGKn} kn` : '—'})
            </Text>
            <Text style={styles.disclaimerText}>
              ⚠️ {sailingStats.windSource === 'gps_estimated'
                ? sailingStats.wind.disclaimer
                : 'Wind direction from stored forecast data, not this session\'s GPS track.'}
            </Text>
          </>
        )}
      </SharedCard>

      <FeatureGate
        feature="COACHING_REPORT"
        onUpgradePress={() => navigation.navigate('Upgrade', { featureId: 'COACHING_REPORT' })}
      >
        {coachingNotes.length === 0 ? (
          <SharedCard>
            <Text style={styles.row}>No coaching report generated for this session yet.</Text>
          </SharedCard>
        ) : (
          coachingNotes.map((note) => {
            const expanded = expandedNoteId === note.id;
            return (
              <SharedCard key={note.id}>
                <Text style={styles.row}>
                  🏄 Coaching report{note.generated_at ? ` — ${formatLocalTime(note.generated_at)}` : ''}
                </Text>
                {expanded && (
                  <Text style={[styles.row, { marginTop: 8 }]}>{note.report_text}</Text>
                )}
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.reportBtn}
                  onPress={() => setExpandedNoteId(expanded ? null : note.id)}
                >
                  <Text style={styles.reportBtnText}>{expanded ? 'Hide report' : '📖 Read report'}</Text>
                </TouchableOpacity>
              </SharedCard>
            );
          })
        )}
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
  disclaimerText: { color: '#f0a500', fontSize: 11, marginTop: 4 },
  peakMomentBtn: {
    backgroundColor: '#f0a500', paddingVertical: 12, borderRadius: 12,
    alignItems: 'center', marginTop: 14,
  },
  peakMomentBtnText: { color: colors.deep, fontWeight: '800', fontSize: 14 },
  reportBtn: {
    backgroundColor: 'rgba(26,138,181,0.15)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.3)',
    paddingVertical: 8, borderRadius: 10, alignItems: 'center', marginTop: 10,
  },
  reportBtnText: { color: colors.accent, fontWeight: '700', fontSize: 13 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },
});

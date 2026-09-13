import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, StyleSheet, TouchableOpacity, Image, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import {
  UserStore, TierService, canAccess,
  SessionRepository, WeatherRepository, AnalysisRepository, TrackpointRepository,
} from '@commandersuite/core';
import SharedCard from '../components/SharedCard';
import SessionMapPreview from '../components/SessionMapPreview';
import { colors } from '../theme';

function formatDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function compass(deg) {
  if (deg === null || deg === undefined) return '—';
  return COMPASS[Math.round(deg / 22.5) % 16];
}

function verdict(windKn) {
  if (windKn === null || windKn === undefined) return { label: '—', color: colors.text };
  if (windKn > 15) return { label: '✅ Good day', color: colors.green };
  if (windKn >= 10) return { label: '⚠️ Marginal', color: colors.amber };
  return { label: '❌ Stay home', color: colors.danger };
}

export default function HomeScreen({ navigation }) {
  const [nickname, setNickname] = useState('');
  const [tier, setTier] = useState('free');
  const [weather, setWeather] = useState(null);
  const [lastSession, setLastSession] = useState(null);
  const [lastSessionTrackpoints, setLastSessionTrackpoints] = useState([]);
  const [latestAnalysis, setLatestAnalysis] = useState(null);
  const [bests, setBests] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [user, cachedTier, weatherRows, recent, analysis, personalBests] = await Promise.all([
        UserStore.getUser(),
        TierService.getCachedTier(),
        WeatherRepository.getAllToday(),
        SessionRepository.getRecentSessions(1),
        AnalysisRepository.getLatestAnalysis(),
        SessionRepository.getPersonalBests(),
      ]);

      setNickname(user?.nickname || 'Rob');
      setTier(cachedTier);
      setWeather(weatherRows?.[0] || null);
      setBests(personalBests);
      setLatestAnalysis(analysis || null);

      const session = recent?.[0] || null;
      setLastSession(session);
      if (session) {
        setLastSessionTrackpoints(await TrackpointRepository.getSampledForSession(session.session_id, 80));
      } else {
        setLastSessionTrackpoints([]);
      }
    } catch (err) {
      console.warn('[Home] load error:', err.message);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const v = verdict(weather?.best_wind_kn ?? null);
  const canSeeSkeleton = canAccess('FULL_ANALYSIS', tier);

  return (
    <SafeAreaView style={styles.scrollBg} edges={['top']}>
    <ScrollView
      style={styles.scrollBg}
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>{greeting()} {nickname}</Text>
          <Text style={styles.dateText}>{todayLabel()}</Text>
        </View>
        <TouchableOpacity style={styles.tierBadge} onPress={() => navigation.navigate('Upgrade')}>
          <Text style={styles.tierBadgeText}>{tier.toUpperCase()}</Text>
        </TouchableOpacity>
      </View>

      {/* Today's conditions */}
      <SharedCard>
        <Text style={styles.cardLabel}>🌊 Today's Conditions</Text>
        {weather ? (
          <>
            <Text style={styles.conditionsLine}>
              Wind {weather.best_wind_kn ?? '—'} kn {compass(weather.best_wind_dir)} · Best time {weather.best_time ?? '—'}
            </Text>
            <Text style={styles.conditionsLine}>
              Wave {weather.wave_height_m != null ? `${weather.wave_height_m} m` : '—'} · Temp {weather.temperature_c != null ? `${weather.temperature_c}°C` : '—'}
            </Text>
            <Text style={[styles.verdict, { color: v.color }]}>{v.label}</Text>
          </>
        ) : (
          <Text style={styles.emptyText}>No forecast cached yet.</Text>
        )}
        <TouchableOpacity onPress={() => navigation.navigate('Weather')}>
          <Text style={styles.linkText}>View full forecast →</Text>
        </TouchableOpacity>
      </SharedCard>

      {/* Last session */}
      <SharedCard>
        <Text style={styles.cardLabel}>📅 Last Session</Text>
        {lastSession ? (
          <>
            <Text style={styles.conditionsLine}>
              {lastSession.date} {lastSession.start_time ? `· ${lastSession.start_time}` : ''}
            </Text>
            <Text style={styles.conditionsLine}>
              {formatDuration(lastSession.duration_s)}
              {lastSession.max_speed_kn ? ` · ${lastSession.max_speed_kn.toFixed(1)} kn peak` : ''}
              {lastSession.distance_m ? ` · ${(lastSession.distance_m / 1000).toFixed(1)} km` : ''}
            </Text>
            <SessionMapPreview
              trackpoints={lastSessionTrackpoints}
              onPress={() => navigation.navigate('SessionDetail', { sessionId: lastSession.session_id })}
            />
          </>
        ) : (
          <Text style={styles.emptyText}>No sessions yet.</Text>
        )}
        <TouchableOpacity onPress={() => navigation.navigate('Sessions')}>
          <Text style={styles.linkText}>View all sessions →</Text>
        </TouchableOpacity>
      </SharedCard>

      {/* Last analysis teaser — the hero */}
      <SharedCard style={styles.teaserCard}>
        <Text style={styles.cardLabel}>🏄 Last Analysis</Text>
        {latestAnalysis?.last_frame_base64 ? (
          <View style={styles.teaserFrameWrap}>
            <Image
              source={{ uri: 'data:image/jpeg;base64,' + latestAnalysis.last_frame_base64 }}
              style={[styles.teaserFrame, !canSeeSkeleton && styles.teaserFrameLocked]}
              resizeMode="cover"
            />
            {!canSeeSkeleton && (
              <View style={styles.teaserOverlay}>
                <Text style={styles.teaserLockIcon}>🔒</Text>
                <Text style={styles.teaserOverlayTitle}>See your biomechanics</Text>
                <Text style={styles.teaserOverlayBody}>
                  Upgrade to Premium to unlock skeleton overlay, coaching reports and frame review
                </Text>
                <TouchableOpacity style={styles.teaserBtn} onPress={() => navigation.navigate('Upgrade')}>
                  <Text style={styles.teaserBtnText}>Upgrade</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.teaserEmpty}>
            <Text style={styles.teaserEmptyIcon}>🎥</Text>
            <Text style={styles.teaserEmptyText}>Import a GoPro video to analyse your technique</Text>
            <TouchableOpacity style={styles.teaserBtn} onPress={() => navigation.navigate('Video')}>
              <Text style={styles.teaserBtnText}>Import Video</Text>
            </TouchableOpacity>
          </View>
        )}
      </SharedCard>

      {/* Personal bests */}
      <SharedCard>
        <Text style={styles.cardLabel}>🏆 Personal Bests</Text>
        <Text style={styles.bestSpeed}>
          {bests?.best_speed ? bests.best_speed.toFixed(1) : '—'} <Text style={styles.bestSpeedUnit}>kn</Text>
        </Text>
        <View style={styles.bestsRow}>
          <View style={styles.bestsCell}>
            <Text style={styles.bestsValue}>{bests?.total_sessions ?? 0}</Text>
            <Text style={styles.bestsLabel}>sessions</Text>
          </View>
          <View style={styles.bestsCell}>
            <Text style={styles.bestsValue}>{bests?.best_distance ? `${(bests.best_distance / 1000).toFixed(1)} km` : '—'}</Text>
            <Text style={styles.bestsLabel}>best distance</Text>
          </View>
          <View style={styles.bestsCell}>
            <Text style={styles.bestsValue}>{formatDuration(bests?.total_time_s)}</Text>
            <Text style={styles.bestsLabel}>total time</Text>
          </View>
        </View>
      </SharedCard>

      {/* Quick actions */}
      <View style={styles.quickRow}>
        <TouchableOpacity style={styles.quickBtn} onPress={() => navigation.navigate('Sessions')}>
          <Text style={styles.quickBtnIcon}>📥</Text>
          <Text style={styles.quickBtnText}>Import FIT</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickBtn} onPress={() => navigation.navigate('Video')}>
          <Text style={styles.quickBtnIcon}>🎬</Text>
          <Text style={styles.quickBtnText}>Import Video</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickBtn} onPress={() => navigation.navigate('Weather')}>
          <Text style={styles.quickBtnIcon}>🌊</Text>
          <Text style={styles.quickBtnText}>Weather</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.quickBtn}
          onPress={() => lastSession
            ? navigation.navigate('PeakMoment', { sessionId: lastSession.session_id })
            : navigation.navigate('Sessions')}
        >
          <Text style={styles.quickBtnIcon}>🏆</Text>
          <Text style={styles.quickBtnText}>Peak Moment</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 12, marginBottom: 16 },
  greeting: { color: '#fff', fontSize: 22, fontWeight: '800' },
  dateText: { color: 'rgba(205,232,240,0.5)', fontSize: 13, marginTop: 2 },
  tierBadge: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10 },
  tierBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 1 },

  cardLabel: {
    color: 'rgba(205,232,240,0.6)', fontSize: 12, fontWeight: '700',
    letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8,
  },
  conditionsLine: { color: colors.text, fontSize: 13, marginBottom: 3 },
  verdict: { fontSize: 14, fontWeight: '700', marginTop: 4, marginBottom: 6 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 12, marginBottom: 4 },
  linkText: { color: colors.accent, fontSize: 12, fontWeight: '600', marginTop: 6 },

  teaserCard: { padding: 0, overflow: 'hidden' },
  teaserFrameWrap: { position: 'relative', margin: 12, borderRadius: 10, overflow: 'hidden' },
  teaserFrame: { width: '100%', height: 220, backgroundColor: '#000' },
  teaserFrameLocked: { opacity: 0.3 },
  teaserOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', padding: 20,
    backgroundColor: 'rgba(6,31,46,0.35)',
  },
  teaserLockIcon: { fontSize: 28, marginBottom: 6 },
  teaserOverlayTitle: { color: '#fff', fontSize: 16, fontWeight: '800', marginBottom: 6, textAlign: 'center' },
  teaserOverlayBody: { color: 'rgba(255,255,255,0.85)', fontSize: 12, textAlign: 'center', marginBottom: 12 },
  teaserBtn: { backgroundColor: colors.accent, paddingVertical: 9, paddingHorizontal: 22, borderRadius: 8 },
  teaserBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  teaserEmpty: { alignItems: 'center', padding: 24 },
  teaserEmptyIcon: { fontSize: 32, marginBottom: 8 },
  teaserEmptyText: { color: 'rgba(205,232,240,0.6)', fontSize: 13, textAlign: 'center', marginBottom: 14 },

  bestSpeed: { color: colors.amber, fontSize: 40, fontWeight: '800', marginBottom: 8 },
  bestSpeedUnit: { fontSize: 18, fontWeight: '700' },
  bestsRow: { flexDirection: 'row', gap: 10 },
  bestsCell: { flex: 1, alignItems: 'center' },
  bestsValue: { color: colors.text, fontSize: 15, fontWeight: '700' },
  bestsLabel: { color: 'rgba(205,232,240,0.5)', fontSize: 10, marginTop: 2, textAlign: 'center' },

  quickRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  quickBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 12,
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.3)',
  },
  quickBtnIcon: { fontSize: 20, marginBottom: 6 },
  quickBtnText: { color: colors.text, fontSize: 11, fontWeight: '600', textAlign: 'center' },
});

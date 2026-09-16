import React, { useCallback, useState } from 'react';
import {
  ScrollView, Text, View, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, FlatList,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WeatherRepository, UserStore, TierService } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { ALL_BEACHES, seedBeaches } from '../utils/seedBeaches';
import { WeatherService, fetchBeachWeather, conditionIndicator, degreesToCompass } from '../services/WeatherService';
import { colors } from '../theme';

const MAX_BEACHES = 5;
const SELECTION_KEY = 'ws_selected_beach_names';

const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function compass(deg) {
  if (deg === null || deg === undefined) return '—';
  return COMPASS[Math.round(deg / 22.5) % 16];
}

function verdict(windKn) {
  if (windKn === null) return { label: '—', color: colors.text };
  if (windKn > 15) return { label: '✅ Go', color: colors.green };
  if (windKn >= 10) return { label: '⚠️ Marginal', color: colors.amber };
  return { label: '❌ Stay home', color: colors.danger };
}

function verdictSentence(windKn) {
  if (windKn == null) return 'No forecast data for today yet.';
  if (windKn > 15) return 'Great conditions today!';
  if (windKn >= 10) return 'Marginal conditions today - check closer to your session.';
  return 'Not ideal today - wind too light';
}

function parseHourlyForecast(weather) {
  if (!weather?.forecast_json) return [];
  try {
    const parsed = typeof weather.forecast_json === 'string'
      ? JSON.parse(weather.forecast_json)
      : weather.forecast_json;
    return parsed?.hourly || [];
  } catch {
    return [];
  }
}

export default function WeatherScreen() {
  const insets = useSafeAreaInsets();
  const [selectedNames, setSelectedNames] = useState([]);
  const [forecasts, setForecasts] = useState({});
  const [loading, setLoading] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pendingSelection, setPendingSelection] = useState([]);
  const [favouriteBeach, setFavouriteBeach] = useState(null);
  const [tier, setTier] = useState('free');

  const [beachChecks, setBeachChecks] = useState([]);
  const [selectedCheck, setSelectedCheck] = useState(null); // { beach, weather, condition } | null
  const [kitRec, setKitRec] = useState(null); // { mode, combos, text } | null
  const [kitRecLoading, setKitRecLoading] = useState(false);
  const [tideStateNow, setTideStateNow] = useState(null);

  const [forecast5Day, setForecast5Day] = useState([]);
  const [forecast5Loading, setForecast5Loading] = useState(false);

  const [briefingVisible, setBriefingVisible] = useState(false);
  const [briefingText, setBriefingText] = useState('');
  const [briefingLoading, setBriefingLoading] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        await seedBeaches();
        const [stored, favourite, cachedTier, tideState] = await Promise.all([
          AsyncStorage.getItem(SELECTION_KEY),
          UserStore.getFavouriteBeach(),
          TierService.getCachedTier(),
          WeatherService.getTideStateNow(),
        ]);
        const names = stored ? JSON.parse(stored) : [];
        if (cancelled) return;
        setSelectedNames(names);
        setFavouriteBeach(favourite);
        setTier(cachedTier);
        setTideStateNow(tideState);
        await loadForecasts(names, { forceRefresh: false });

        const checks = await WeatherService.getBeachChecks();
        if (!cancelled) setBeachChecks(checks);

        if (favourite) {
          setForecast5Loading(true);
          WeatherService.get5DayForecast(favourite)
            .then((rows) => { if (!cancelled) setForecast5Day(rows); })
            .catch((err) => console.warn('[Weather] 5-day forecast failed:', err.message))
            .finally(() => { if (!cancelled) setForecast5Loading(false); });
        }
      })();
      return () => { cancelled = true; };
    }, [])
  );

  const [detailRefreshing, setDetailRefreshing] = useState(false);

  async function openBeachDetail(check) {
    setSelectedCheck(check);
    setKitRec(null);
    setKitRecLoading(true);
    try {
      const rec = await WeatherService.getKitRecommendation({
        beach: check.beach, weather: check.weather, tideState: tideStateNow, tier,
      });
      setKitRec(rec);
    } catch (err) {
      // AI kit text can fail independently of the data-only fallback (e.g.
      // model not downloaded yet) — fall back to the plain combo list
      // rather than leaving the sheet on an uncaught rejection.
      console.warn('[Weather] kit recommendation failed:', err.message);
      setKitRec({ mode: 'data', combos: [], text: null });
    } finally {
      setKitRecLoading(false);
    }
  }

  // Bypasses getBeachChecks()'s cache-first read — used when the cached
  // row predates the hourly breakdown, or is otherwise stale, and the user
  // wants today's forecast re-fetched right now rather than waiting for
  // the date to roll over.
  async function refreshBeachDetail() {
    if (!selectedCheck) return;
    setDetailRefreshing(true);
    try {
      const updated = await WeatherService.refreshBeachCheck(selectedCheck.beach);
      setSelectedCheck(updated);
      setBeachChecks((prev) => prev.map((c) => (c.beach.id === updated.beach.id ? updated : c)));
    } catch (err) {
      console.warn('[Weather] beach detail refresh failed:', err.message);
    } finally {
      setDetailRefreshing(false);
    }
  }

  async function openBriefing() {
    setBriefingVisible(true);
    setBriefingLoading(true);
    setBriefingText('');
    try {
      const favouriteCheck = beachChecks.find((c) => c.beach.id === favouriteBeach?.id);
      const text = await WeatherService.getBriefing({
        beach: favouriteBeach,
        weather: favouriteCheck?.weather ?? null,
        tideState: tideStateNow,
        tier,
      });
      setBriefingText(text || "Upgrade to Premium to unlock AI briefings.");
    } catch (err) {
      setBriefingText('⚠️ ' + (err.message || 'Could not generate briefing.'));
    } finally {
      setBriefingLoading(false);
    }
  }

  // Cache-first: only hits the network for a beach if there's no cached
  // forecast for today yet, so simply reopening this screen doesn't refetch
  // the same place over and over. Pass forceRefresh to bypass the cache.
  async function loadForecasts(names, { forceRefresh }) {
    if (!names.length) { setForecasts({}); return; }
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const results = {};
      for (const name of names) {
        const beach = ALL_BEACHES.find((b) => b.name === name);
        if (!beach) continue;

        if (!forceRefresh) {
          const cached = await WeatherRepository.getForBeach(name, today);
          if (cached) { results[name] = cached; continue; }
        }

        try {
          const forecast = await fetchBeachWeather(beach);
          await WeatherRepository.cache(forecast);
          results[name] = forecast;
        } catch (err) {
          console.warn('[Weather] fetch failed for', name, err.message);
          const cached = await WeatherRepository.getForBeach(name, today);
          if (cached) results[name] = cached;
        }
      }
      setForecasts(results);
    } finally {
      setLoading(false);
    }
  }

  function openPicker() {
    setPendingSelection(selectedNames);
    setPickerVisible(true);
  }

  function toggleBeach(name) {
    setPendingSelection((prev) => {
      if (prev.includes(name)) return prev.filter((n) => n !== name);
      if (prev.length >= MAX_BEACHES) return prev;
      return [...prev, name];
    });
  }

  async function saveSelection() {
    await AsyncStorage.setItem(SELECTION_KEY, JSON.stringify(pendingSelection));
    setSelectedNames(pendingSelection);
    setPickerVisible(false);
    await loadForecasts(pendingSelection, { forceRefresh: false });
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header
        badge={favouriteBeach ? `⭐ ${favouriteBeach.name}` : `Free tier · ${selectedNames.length}/${MAX_BEACHES} beaches`}
        title="🌊 Weather"
      />

      <TouchableOpacity activeOpacity={0.7} style={styles.briefingBtn} onPress={openBriefing}>
        <Text style={styles.briefingBtnText}>☀️ Today's Full Briefing</Text>
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.7} style={styles.pickBtn} onPress={openPicker}>
        <Text style={styles.pickBtnText}>📍 Choose Beaches</Text>
      </TouchableOpacity>

      {loading && <ActivityIndicator color={colors.accent} style={{ marginVertical: 12 }} />}

      {selectedNames.length === 0 ? (
        <Text style={styles.emptyText}>No beaches selected yet — tap "Choose Beaches" to get started.</Text>
      ) : (
        selectedNames.map((name) => {
          const beach = ALL_BEACHES.find((b) => b.name === name);
          const f = forecasts[name];
          const v = verdict(f?.best_wind_kn ?? null);
          return (
            <SharedCard key={name}>
              <Text style={styles.beachName}>{beach?.emoji} {name}</Text>
              {f ? (
                <>
                  <Text style={styles.line}>
                    Wind: {f.best_wind_kn ?? '—'} kn {compass(f.best_wind_dir)} · Best time {f.best_time ?? '—'}
                  </Text>
                  <Text style={styles.line}>
                    Wave: {f.wave_height_m != null ? `${f.wave_height_m} m` : '—'} · Temp: {f.temperature_c != null ? `${f.temperature_c}°C` : '—'}
                  </Text>
                  <Text style={[styles.verdict, { color: v.color }]}>{v.label}</Text>
                </>
              ) : (
                <Text style={styles.line}>No forecast yet</Text>
              )}
            </SharedCard>
          );
        })
      )}

      {selectedNames.length > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.refreshBtn} onPress={() => loadForecasts(selectedNames, { forceRefresh: true })}>
          <Text style={styles.refreshBtnText}>🔄 Refresh Forecast</Text>
        </TouchableOpacity>
      )}

      {favouriteBeach && (
        <>
          <Text style={styles.sectionLabel}>5-Day Forecast — {favouriteBeach.name}</Text>
          <SharedCard>
            {forecast5Loading ? (
              <ActivityIndicator color={colors.accent} />
            ) : forecast5Day.length === 0 ? (
              <Text style={styles.line}>No forecast available</Text>
            ) : (
              <View style={styles.forecastRow}>
                {forecast5Day.map((d) => (
                  <View key={d.date} style={styles.forecastDay}>
                    <Text style={styles.forecastDayName}>{d.dayName}</Text>
                    <Text style={styles.forecastVerdict}>{d.verdict}</Text>
                    <Text style={styles.forecastLine}>{d.windKn != null ? `${Math.round(d.windKn)}kn` : '—'}</Text>
                    <Text style={styles.forecastLine}>{d.windDir || '—'}</Text>
                    <Text style={styles.forecastLine}>{d.waveM != null ? `${d.waveM.toFixed(1)}m` : '—'}</Text>
                  </View>
                ))}
              </View>
            )}
          </SharedCard>
        </>
      )}

      <Text style={styles.sectionLabel}>Beach Checks</Text>
      <View style={styles.beachChecksGrid}>
        {beachChecks.map((check) => (
          <TouchableOpacity
            activeOpacity={0.7}
            key={check.beach.id}
            style={styles.checkCard}
            onPress={() => openBeachDetail(check)}
          >
            <Text style={styles.checkCardEmoji}>{check.beach.emoji || ALL_BEACHES.find((b) => b.name === check.beach.name)?.emoji || '📍'}</Text>
            <Text style={styles.checkCardName} numberOfLines={1}>{check.beach.name}</Text>
            <Text style={styles.checkCardCondition}>{check.condition.emoji} {check.condition.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Modal statusBarTranslucent visible={pickerVisible} animationType="slide" onRequestClose={() => setPickerVisible(false)}>
        <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
          <Text style={styles.modalTitle}>Choose up to {MAX_BEACHES} beaches</Text>

          <FlatList showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
            data={[...ALL_BEACHES].sort((a, b) => a.name.localeCompare(b.name))}
            keyExtractor={(b) => b.name}
            contentContainerStyle={{ paddingHorizontal: 16 }}
            renderItem={({ item }) => {
              const checked = pendingSelection.includes(item.name);
              return (
                <TouchableOpacity activeOpacity={0.7} style={styles.beachRow} onPress={() => toggleBeach(item.name)}>
                  <Text style={styles.beachRowEmoji}>{item.emoji}</Text>
                  <Text style={styles.beachRowName}>{item.name}</Text>
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked && <Text style={styles.checkboxTick}>✓</Text>}
                  </View>
                </TouchableOpacity>
              );
            }}
          />

          <View style={styles.modalBottomBar}>
            <TouchableOpacity activeOpacity={0.7} style={styles.modalCancelBtn} onPress={() => setPickerVisible(false)}>
              <Text style={styles.modalCancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7} style={styles.modalSaveBtn} onPress={saveSelection}>
              <Text style={styles.modalSaveBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      <Modal statusBarTranslucent visible={!!selectedCheck} animationType="slide" onRequestClose={() => setSelectedCheck(null)}>
        <View style={styles.detailPage}>
          {selectedCheck && (
            <>
              <View style={[styles.detailHeaderBar, { paddingTop: insets.top + 8 }]}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => setSelectedCheck(null)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={styles.detailBackBtnHit}
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                >
                  <Text style={styles.detailBackBtn}>‹ Back</Text>
                </TouchableOpacity>
                <Text style={styles.detailHeaderTitle} numberOfLines={1}>{selectedCheck.beach.name}</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={refreshBeachDetail}
                  disabled={detailRefreshing}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={styles.detailBackBtnHit}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh forecast"
                >
                  {detailRefreshing ? (
                    <ActivityIndicator color={colors.accent} size="small" />
                  ) : (
                    <Text style={[styles.detailBackBtn, { textAlign: 'right' }]}>🔄 Refresh</Text>
                  )}
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={[styles.detailBody, { paddingBottom: insets.bottom + 24 }]}>
                <Text style={styles.detailBeachName}>
                  {selectedCheck.beach.emoji || '🏖️'} {selectedCheck.beach.name}
                </Text>

                {selectedCheck.weather ? (
                  <>
                    <Text style={styles.detailLine}>
                      🌊 <Text style={styles.detailLineLabel}>Tide:</Text>{' '}
                      {tideStateNow?.value_m != null ? `${tideStateNow.value_m}m — ` : ''}
                      {tideStateNow?.value_m != null ? (
                        <Text style={{ color: colors.green, fontWeight: '700' }}>✅ SAFE</Text>
                      ) : (
                        <Text style={{ color: 'rgba(205,232,240,0.4)' }}>No tide data</Text>
                      )}
                    </Text>
                    <Text style={styles.detailLine}>
                      💨 <Text style={styles.detailLineLabel}>Best wind:</Text>{' '}
                      {selectedCheck.weather.best_wind_kn ?? '—'}kn {compass(selectedCheck.weather.best_wind_dir)}
                      {selectedCheck.weather.best_wind_dir != null ? ` (${Math.round(selectedCheck.weather.best_wind_dir)}°)` : ''}
                      {selectedCheck.weather.best_time ? ` at ${selectedCheck.weather.best_time}` : ''}
                    </Text>
                    <Text style={styles.detailLine}>
                      🌡️ <Text style={styles.detailLineLabel}>Temp:</Text>{' '}
                      {selectedCheck.weather.temperature_c != null ? `${selectedCheck.weather.temperature_c}°C` : '—'}
                    </Text>
                    <Text style={styles.detailLine}>
                      🏄 <Text style={styles.detailLineLabel}>Gear:</Text>{' '}
                      {kitRecLoading
                        ? '…'
                        : kitRec?.combos?.length
                        ? kitRec.combos.map((c) => c.name || [c.board_name, c.sail_name].filter(Boolean).join(' / ')).join(' + ')
                        : 'No matching gear logged'}
                    </Text>

                    <Text style={styles.detailSectionLabel}>Hourly forecast:</Text>
                    <View style={styles.hourlyBox}>
                      {parseHourlyForecast(selectedCheck.weather).length ? (
                        parseHourlyForecast(selectedCheck.weather).map((h) => (
                          <Text key={h.time} style={styles.hourlyLine}>
                            {h.time} | {h.wind_kn ?? '—'}kn | {compass(h.wind_dir)} ({h.wind_dir != null ? Math.round(h.wind_dir) : '—'}°)
                          </Text>
                        ))
                      ) : (
                        <Text style={styles.hourlyLine}>No hourly breakdown cached — pull to refresh.</Text>
                      )}
                    </View>

                    {kitRec?.mode === 'ai' && kitRec.text && (
                      <>
                        <Text style={styles.detailSectionLabel}>AI Kit Recommendation:</Text>
                        <Text style={styles.detailLine}>{kitRec.text}</Text>
                      </>
                    )}

                    <Text style={styles.detailVerdict}>
                      <Text style={styles.detailLineLabel}>Verdict:</Text> {verdictSentence(selectedCheck.weather.best_wind_kn)}
                    </Text>
                    {selectedCheck.weather.best_time && (
                      <Text style={styles.detailUpdated}>(Last updated: {selectedCheck.weather.best_time})</Text>
                    )}
                  </>
                ) : (
                  <Text style={styles.detailLine}>No cached weather for today</Text>
                )}
              </ScrollView>
            </>
          )}
        </View>
      </Modal>

      <Modal statusBarTranslucent visible={briefingVisible} animationType="slide" transparent onRequestClose={() => setBriefingVisible(false)}>
        <View style={styles.overlay}>
          <View style={styles.detailSheet}>
            <Text style={styles.modalTitle}>☀️ Today's Briefing</Text>
            {briefingLoading ? (
              <ActivityIndicator color={colors.accent} style={{ marginVertical: 20 }} />
            ) : (
              <Text style={styles.line}>{briefingText}</Text>
            )}
            <TouchableOpacity activeOpacity={0.7} style={styles.modalCloseBtn} onPress={() => setBriefingVisible(false)}>
              <Text style={styles.modalCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  beachName: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  line: { color: 'rgba(205,232,240,0.7)', fontSize: 13, marginBottom: 2 },
  verdict: { fontSize: 14, fontWeight: '700', marginTop: 6 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },

  pickBtn: {
    backgroundColor: 'rgba(26,138,181,0.15)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.3)',
    padding: 14, borderRadius: 12, alignItems: 'center', marginBottom: 12,
  },
  pickBtnText: { color: colors.text, fontWeight: '700', fontSize: 14 },

  refreshBtn: {
    backgroundColor: colors.accent, padding: 14, borderRadius: 12,
    alignItems: 'center', marginTop: 8,
  },
  refreshBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  modal: { flex: 1, backgroundColor: colors.deep },
  modalTitle: {
    color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center',
    paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(26,138,181,0.2)',
  },
  modalBottomBar: {
    flexDirection: 'row', gap: 10, padding: 16,
    borderTopWidth: 1, borderTopColor: 'rgba(26,138,181,0.2)',
  },
  modalCancelBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center',
    backgroundColor: 'rgba(230,57,70,0.15)', borderWidth: 1, borderColor: 'rgba(230,57,70,0.3)',
  },
  modalCancelBtnText: { color: colors.danger, fontSize: 15, fontWeight: '700' },
  modalSaveBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center',
    backgroundColor: colors.accent,
  },
  modalSaveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  detailPage: { flex: 1, backgroundColor: colors.deep },
  detailHeaderBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(26,138,181,0.2)',
  },
  // 44x44pt minimum hit target per Apple's Human Interface Guidelines —
  // the label itself is much smaller, so hitSlop alone isn't enough once
  // it's sitting right under the status bar/notch.
  detailBackBtnHit: { minWidth: 50, minHeight: 44, justifyContent: 'center' },
  detailBackBtn: { color: colors.accent, fontSize: 16 },
  detailHeaderTitle: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  detailBody: { padding: 20 },
  detailBeachName: { color: colors.accent, fontSize: 18, fontWeight: '700', marginBottom: 16 },
  detailLine: { color: colors.text, fontSize: 15, marginBottom: 10, lineHeight: 21 },
  detailLineLabel: { fontWeight: '700' },
  detailSectionLabel: { color: colors.accent, fontSize: 15, fontWeight: '700', marginTop: 14, marginBottom: 8 },
  hourlyBox: {
    borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)', borderRadius: 12,
    padding: 14,
  },
  hourlyLine: { color: colors.text, fontSize: 13, marginBottom: 6, fontVariant: ['tabular-nums'] },
  detailVerdict: { color: colors.text, fontSize: 15, marginTop: 16 },
  detailUpdated: { color: 'rgba(205,232,240,0.5)', fontSize: 13, fontStyle: 'italic', marginTop: 8 },

  beachRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(26,138,181,0.1)',
  },
  beachRowEmoji: { fontSize: 18, marginRight: 10 },
  beachRowName: { flex: 1, color: colors.text, fontSize: 14 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: 'rgba(26,138,181,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkboxTick: { color: '#fff', fontSize: 13, fontWeight: '700' },

  briefingBtn: {
    backgroundColor: colors.accent, padding: 16, borderRadius: 12,
    alignItems: 'center', marginBottom: 12,
  },
  briefingBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  sectionLabel: {
    color: 'rgba(205,232,240,0.5)', fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8, marginTop: 18,
  },

  forecastRow: { flexDirection: 'row', justifyContent: 'space-between' },
  forecastDay: { alignItems: 'center', flex: 1 },
  forecastDayName: { color: colors.text, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  forecastVerdict: { fontSize: 16, marginBottom: 4 },
  forecastLine: { color: 'rgba(205,232,240,0.6)', fontSize: 10 },

  beachChecksGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  checkCard: {
    width: '47%', alignItems: 'center', paddingVertical: 16, borderRadius: 12,
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.3)',
    marginBottom: 10,
  },
  checkCardEmoji: { fontSize: 22, marginBottom: 6 },
  checkCardName: { color: colors.text, fontSize: 12, fontWeight: '700', marginBottom: 4, paddingHorizontal: 4 },
  checkCardCondition: { color: 'rgba(205,232,240,0.6)', fontSize: 11 },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  detailSheet: {
    backgroundColor: colors.deep, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 20, maxHeight: '80%', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  modalCloseBtn: { alignItems: 'center', paddingVertical: 14, marginTop: 14 },
  modalCloseBtnText: { color: 'rgba(205,232,240,0.5)', fontSize: 14, fontWeight: '600' },
});

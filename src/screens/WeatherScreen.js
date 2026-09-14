import React, { useCallback, useState } from 'react';
import {
  ScrollView, Text, View, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, FlatList,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WeatherRepository, UserStore, TierService } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { ALL_BEACHES, seedBeaches } from '../utils/seedBeaches';
import { WeatherService, conditionIndicator, degreesToCompass } from '../services/WeatherService';
import { colors } from '../theme';

const MAX_BEACHES = 5;
const SELECTION_KEY = 'ws_selected_beach_names';

const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function compass(deg) {
  if (deg === null || deg === undefined) return '—';
  return COMPASS[Math.round(deg / 22.5) % 16];
}

async function fetchBeachWeather(beach) {
  const wRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&hourly=windspeed_10m,winddirection_10m,temperature_2m&timezone=auto`
  );
  const wData = await wRes.json();

  const mRes = await fetch(
    `https://marine-api.open-meteo.com/v1/marine?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&hourly=wave_height,wind_wave_height,swell_wave_height&timezone=auto`
  ).catch(() => null);
  const mData = mRes ? await mRes.json().catch(() => null) : null;

  const hours = wData.hourly?.time || [];
  let bestIdx = 0, bestSpeed = -1;
  for (let i = 0; i < hours.length; i++) {
    const speed = wData.hourly.windspeed_10m[i];
    if (speed > bestSpeed) { bestSpeed = speed; bestIdx = i; }
  }

  const bestWindKn = bestSpeed >= 0 ? Math.round(bestSpeed * 0.539957 * 10) / 10 : null;
  const bestWindDir = wData.hourly?.winddirection_10m?.[bestIdx] ?? null;
  const bestTime = hours[bestIdx] ? hours[bestIdx].slice(11, 16) : null;
  const waveHeight = mData?.hourly?.wave_height?.[bestIdx] ?? null;
  const temp = wData.hourly?.temperature_2m?.[bestIdx] ?? null;

  return {
    beach_name: beach.name,
    forecast_date: new Date().toISOString().slice(0, 10),
    best_wind_kn: bestWindKn,
    best_wind_dir: bestWindDir,
    best_time: bestTime,
    wave_height_m: waveHeight,
    temperature_c: temp,
    forecast_json: { hours: hours.length },
  };
}

function verdict(windKn) {
  if (windKn === null) return { label: '—', color: colors.text };
  if (windKn > 15) return { label: '✅ Go', color: colors.green };
  if (windKn >= 10) return { label: '⚠️ Marginal', color: colors.amber };
  return { label: '❌ Stay home', color: colors.danger };
}

export default function WeatherScreen() {
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

  async function openBeachDetail(check) {
    setSelectedCheck(check);
    setKitRec(null);
    setKitRecLoading(true);
    try {
      const rec = await WeatherService.getKitRecommendation({
        beach: check.beach, weather: check.weather, tideState: tideStateNow, tier,
      });
      setKitRec(rec);
    } finally {
      setKitRecLoading(false);
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

      <Modal statusBarTranslucent visible={!!selectedCheck} animationType="slide" transparent onRequestClose={() => setSelectedCheck(null)}>
        <View style={styles.overlay}>
          <View style={styles.detailSheet}>
            {selectedCheck && (
              <>
                <Text style={styles.modalTitle}>{selectedCheck.beach.emoji || '📍'} {selectedCheck.beach.name}</Text>
                {selectedCheck.weather ? (
                  <>
                    <Text style={styles.line}>
                      💨 {selectedCheck.weather.best_wind_kn ?? '—'}kn {compass(selectedCheck.weather.best_wind_dir)}
                    </Text>
                    <Text style={styles.line}>
                      🌊 {selectedCheck.weather.wave_height_m != null ? `${selectedCheck.weather.wave_height_m}m` : '—'}
                    </Text>
                    <Text style={styles.line}>
                      🌡️ {selectedCheck.weather.temperature_c != null ? `${selectedCheck.weather.temperature_c}°C` : '—'}
                    </Text>
                    {tideStateNow && <Text style={styles.line}>🌊 Tide: {tideStateNow.description}</Text>}
                  </>
                ) : (
                  <Text style={styles.line}>No cached weather for today</Text>
                )}

                <Text style={[styles.sectionLabel, { marginTop: 14 }]}>Kit Recommendation</Text>
                {kitRecLoading ? (
                  <ActivityIndicator color={colors.accent} />
                ) : kitRec?.mode === 'ai' && kitRec.text ? (
                  <Text style={styles.line}>{kitRec.text}</Text>
                ) : kitRec?.combos?.length ? (
                  kitRec.combos.map((c) => (
                    <Text key={c.id} style={styles.line}>
                      • {c.name || [c.board_name, c.sail_name].filter(Boolean).join(' / ')}
                      {c.wind_min_kn != null ? ` (${c.wind_min_kn}-${c.wind_max_kn ?? '?'}kn)` : ''}
                    </Text>
                  ))
                ) : (
                  <Text style={styles.line}>No matching gear combos logged for these conditions.</Text>
                )}

                <TouchableOpacity activeOpacity={0.7} style={styles.modalCloseBtn} onPress={() => setSelectedCheck(null)}>
                  <Text style={styles.modalCloseBtnText}>Close</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
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

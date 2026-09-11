import React, { useCallback, useState } from 'react';
import {
  ScrollView, Text, View, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, FlatList,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BeachRepository, WeatherRepository } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { colors } from '../theme';

// Free tier: pick up to 5 beaches to track, chosen from this list.
// Coordinates are approximate (South West England), close enough for
// Open-Meteo's grid resolution.
const ALL_BEACHES = [
  { name: 'Torpoint', emoji: '🎯', lat: 50.3833, lon: -4.1833, sort_order: 0 },
  { name: 'Bigbury on Sea', emoji: '🌊', lat: 50.2822, lon: -3.8905, sort_order: 1 },
  { name: 'Daymer Bay', emoji: '⚠️', lat: 50.5462, lon: -4.8371, sort_order: 2 },
  { name: 'Marazion Beach', emoji: '🏰', lat: 50.1258, lon: -5.4756, sort_order: 3 },
  { name: 'Plymouth Sound', emoji: '⚓', lat: 50.3468, lon: -4.1447, sort_order: 4 },
  { name: 'Par Beach', emoji: '🏖️', lat: 50.3487, lon: -4.7024, sort_order: 5 },
  { name: 'Mothecombe', emoji: '🌿', lat: 50.3010, lon: -3.9575, sort_order: 6 },
  { name: 'Whitsands', emoji: '🪖', lat: 50.3376, lon: -4.2478, sort_order: 7 },
  { name: 'Slapton Sands', emoji: '🏝️', lat: 50.2814, lon: -3.6479, sort_order: 8 },
  { name: 'Wembury', emoji: '🐚', lat: 50.3138, lon: -4.0855, sort_order: 9 },
  { name: 'Thurlestone', emoji: '🪨', lat: 50.2665, lon: -3.8590, sort_order: 10 },
  { name: 'Siblyback Lake', emoji: '🏞️', lat: 50.4926, lon: -4.4693, sort_order: 11 },
  { name: 'Coverack', emoji: '🎣', lat: 50.0295, lon: -5.0995, sort_order: 12 },
  { name: 'Poole Harbour', emoji: '⛵', lat: 50.7000, lon: -1.9700, sort_order: 13 },
  { name: 'Weymouth Portland Harbour', emoji: '🚀', lat: 50.6047, lon: -2.4517, sort_order: 14 },
  { name: 'Paignton', emoji: '🎡', lat: 50.4333, lon: -3.5667, sort_order: 15 },
];

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

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        await BeachRepository.seedDefaults(ALL_BEACHES);
        const stored = await AsyncStorage.getItem(SELECTION_KEY);
        const names = stored ? JSON.parse(stored) : [];
        if (cancelled) return;
        setSelectedNames(names);
        await loadForecasts(names, { forceRefresh: false });
      })();
      return () => { cancelled = true; };
    }, [])
  );

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
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={`Free tier · ${selectedNames.length}/${MAX_BEACHES} beaches`} title="🌊 Weather" />

      <TouchableOpacity style={styles.pickBtn} onPress={openPicker}>
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
        <TouchableOpacity style={styles.refreshBtn} onPress={() => loadForecasts(selectedNames, { forceRefresh: true })}>
          <Text style={styles.refreshBtnText}>🔄 Refresh Forecast</Text>
        </TouchableOpacity>
      )}

      <Modal visible={pickerVisible} animationType="slide" onRequestClose={() => setPickerVisible(false)}>
        <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
          <Text style={styles.modalTitle}>Choose up to {MAX_BEACHES} beaches</Text>

          <FlatList
            data={ALL_BEACHES}
            keyExtractor={(b) => b.name}
            contentContainerStyle={{ paddingHorizontal: 16 }}
            renderItem={({ item }) => {
              const checked = pendingSelection.includes(item.name);
              return (
                <TouchableOpacity style={styles.beachRow} onPress={() => toggleBeach(item.name)}>
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
            <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setPickerVisible(false)}>
              <Text style={styles.modalCancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalSaveBtn} onPress={saveSelection}>
              <Text style={styles.modalSaveBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
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
});

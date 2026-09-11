import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { BeachRepository, WeatherRepository, canAccess, TierService } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { colors } from '../theme';

// Free tier default beach — seeded once if the local beaches table is empty.
const DEFAULT_BEACHES = [
  { name: 'Torpoint', lat: 50.3833, lon: -4.1833, wind_dirs_good: 'SW,W,NW', sort_order: 0 },
];

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
  const [beaches, setBeaches] = useState([]);
  const [forecasts, setForecasts] = useState({});
  const [loading, setLoading] = useState(false);
  const [canAddMore, setCanAddMore] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        await BeachRepository.seedDefaults(DEFAULT_BEACHES);
        const list = await BeachRepository.getAll();
        const tier = await TierService.getCachedTier();
        if (cancelled) return;
        setBeaches(list);
        setCanAddMore(canAccess('BEACH_LIST', tier));
        refreshAll(list);
      })();
      return () => { cancelled = true; };
    }, [])
  );

  async function refreshAll(list) {
    setLoading(true);
    try {
      const results = {};
      for (const beach of list) {
        try {
          const forecast = await fetchBeachWeather(beach);
          await WeatherRepository.cache(forecast);
          results[beach.id] = forecast;
        } catch (err) {
          console.warn('[Weather] fetch failed for', beach.name, err.message);
          const cached = await WeatherRepository.getForBeach(beach.name);
          if (cached) results[beach.id] = cached;
        }
      }
      setForecasts(results);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge="Free tier · 1 beach" title="🌊 Weather" />

      {loading && <ActivityIndicator color={colors.accent} style={{ marginVertical: 12 }} />}

      {beaches.map((beach) => {
        const f = forecasts[beach.id];
        const v = verdict(f?.best_wind_kn ?? null);
        return (
          <SharedCard key={beach.id}>
            <Text style={styles.beachName}>{beach.name}</Text>
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
      })}

      {!canAddMore && (
        <SharedCard>
          <Text style={styles.upgradeText}>
            Upgrade to Premium to track up to 5 beaches, or Ultimate for unlimited.
          </Text>
        </SharedCard>
      )}

      <TouchableOpacity style={styles.refreshBtn} onPress={() => refreshAll(beaches)}>
        <Text style={styles.refreshBtnText}>🔄 Refresh Forecast</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  beachName: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  line: { color: 'rgba(205,232,240,0.7)', fontSize: 13, marginBottom: 2 },
  verdict: { fontSize: 14, fontWeight: '700', marginTop: 6 },
  upgradeText: { color: 'rgba(205,232,240,0.6)', fontSize: 13, textAlign: 'center' },
  refreshBtn: {
    backgroundColor: colors.accent, padding: 14, borderRadius: 12,
    alignItems: 'center', marginTop: 8,
  },
  refreshBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

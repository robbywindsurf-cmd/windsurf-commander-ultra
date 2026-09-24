import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, InteractionManager, AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDb, UserStore, TierService, EmbeddingService, WeatherRepository, LocalAI, ModelManager, SummaryService } from '@commandersuite/core';
import { seedEquipment } from './src/utils/seedEquipment';
import { seedBeaches } from './src/utils/seedBeaches';
import { fetchBeachWeather, isWeatherStale } from './src/services/WeatherService';
import FavouriteBeachPicker from './src/components/FavouriteBeachPicker';

import HomeScreen from './src/screens/HomeScreen';
import WeatherScreen from './src/screens/WeatherScreen';
import SessionsScreen from './src/screens/SessionsScreen';
import ChatScreen from './src/screens/ChatScreen';
import VideoScreen from './src/screens/VideoScreen';
import GarageScreen from './src/screens/GarageScreen';
import ClipSelectorScreen from './src/screens/ClipSelectorScreen';
import UpgradeScreen from './src/screens/UpgradeScreen';
import SessionDetailScreen from './src/screens/SessionDetailScreen';
import ImportDataScreen from './src/screens/ImportDataScreen';
import PeakMomentScreen from './src/screens/PeakMomentScreen';
import StatsScreen from './src/screens/StatsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { colors } from './src/theme';
import { SiteAuthService } from './src/services/SiteAuthService';
import { IdentityService } from './src/services/IdentityService';
import { repairLegacyTrackpoints, repairMissingDistance, repairMissingCourses } from './src/services/FITImporter';

// The chat LLM context is a true singleton (LocalAI.js) that stays loaded
// for the whole app session once created — backgrounding is the one
// reliable moment to know the rider is done with it for now, so release
// it here rather than between individual messages (releasing per-message
// was the actual cause of "works once, fails on the second question" —
// every message paid the full native load cost again, racing anything
// else touching the model). Registered once at module scope, not inside
// a component, so it isn't re-subscribed on every render.
AppState.addEventListener('change', (state) => {
  if (state === 'background') {
    LocalAI.release().catch((err) => console.warn('[App] failed to release chat context on background:', err.message));
  }
});

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TAB_META = {
  Home: { icon: '🏠', label: 'Home' },
  Weather: { icon: '🌊', label: 'Weather' },
  Sessions: { icon: '📅', label: 'Sessions' },
  Chat: { icon: '💬', label: 'Chat' },
  Video: { icon: '🎬', label: 'Video' },
  Garage: { icon: '⚙️', label: 'Garage' },
};

function TabIcon({ routeName, focused }) {
  const meta = TAB_META[routeName] || { icon: '•', label: routeName };
  return (
    <View style={[tabStyles.pill, focused && tabStyles.pillActive]}>
      <Text style={tabStyles.emoji}>{meta.icon}</Text>
      <Text
        style={[tabStyles.label, focused && tabStyles.labelActive]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {meta.label}
      </Text>
    </View>
  );
}

function MainTabs() {
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: [tabStyles.bar, { paddingBottom: insets.bottom || 8 }],
        tabBarItemStyle: tabStyles.item,
        tabBarIcon: ({ focused }) => <TabIcon routeName={route.name} focused={focused} />,
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Weather" component={WeatherScreen} />
      <Tab.Screen name="Sessions" component={SessionsScreen} />
      <Tab.Screen name="Chat" component={ChatScreen} />
      <Tab.Screen name="Video" component={VideoScreen} />
      <Tab.Screen name="Garage" component={GarageScreen} />
    </Tab.Navigator>
  );
}

const tabStyles = StyleSheet.create({
  bar: {
    backgroundColor: 'rgba(6,31,46,0.97)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(26,138,181,0.25)',
    paddingTop: 6,
  },
  item: { paddingVertical: 2 },
  pill: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 6, paddingHorizontal: 4,
    borderRadius: 9, width: '100%',
  },
  pillActive: {
    backgroundColor: colors.accent,
    shadowColor: colors.accent, shadowOpacity: 0.4,
    shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  emoji: { fontSize: 15, marginBottom: 2 },
  label: { fontSize: 9, fontWeight: '600', letterSpacing: 0.3, color: 'rgba(205,232,240,0.45)', textAlign: 'center', width: '100%' },
  labelActive: { color: '#ffffff' },
});

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [favouriteBeach, setFavouriteBeach] = useState(null); // undefined until checked, null if unset

  useEffect(() => {
    getDb()
      .then(async () => {
        console.log('[DB] Database initialised');
        // One-time cleanup after the Phi-3 -> Llama 3.2 model switch — a
        // no-op once the old file is gone, so safe to call on every launch
        // rather than tracking a "have we done this" flag.
        ModelManager.deleteOldModel().catch((err) => console.warn('[App] failed to delete old model:', err.message));
        // Was previously re-run inside SessionsScreen's load() on every
        // focus/gear-assignment — moved here so it happens once per app
        // launch instead. Each of these is a fast no-op once nothing is
        // actually missing, but the initial check itself (particularly
        // repairMissingCourses' scan over ~950k trackpoint rows, no index
        // on `course`) is real work that shouldn't repeat on every screen
        // visit.
        repairLegacyTrackpoints().catch((err) => console.warn('[App] repairLegacyTrackpoints failed:', err.message));
        repairMissingDistance().catch((err) => console.warn('[App] repairMissingDistance failed:', err.message));
        repairMissingCourses().catch((err) => console.warn('[App] repairMissingCourses failed:', err.message));
        // Patches fetch with the saved site-wide Basic Auth token (if any)
        // before anything else gets a chance to call Oracle — must happen
        // before IdentityService/AuthService's first request, not lazily
        // inside SettingsScreen.
        SiteAuthService.init().catch((err) => console.warn('[App] site auth init failed:', err.message));
        IdentityService.init().catch((err) => console.warn('[App] identity init failed:', err.message));
        await Promise.all([seedEquipment(), seedBeaches()]);
        const favourite = await UserStore.getFavouriteBeach();
        setFavouriteBeach(favourite);
        setDbReady(true);

        // Only recompute if stale (>24h) — refreshSummaries() itself is
        // cheap (current year + rolling recent, not a full rebuild), but
        // no need to run it on every single launch either. Non-blocking:
        // PromptBuilder reads whatever's already in year_summaries/
        // recent_summary, stale-by-a-few-minutes is fine for a chat prompt.
        InteractionManager.runAfterInteractions(async () => {
          try {
            const lastComputed = await SummaryService.getLastComputedAt();
            // SQLite's datetime('now') stores "YYYY-MM-DD HH:MM:SS" (space,
            // no zone) — Date() only parses that reliably once it looks
            // like ISO 8601 (a 'T' and a 'Z' for UTC).
            const staleMs = lastComputed
              ? Date.now() - new Date(lastComputed.replace(' ', 'T') + 'Z').getTime()
              : Infinity;
            if (staleMs > 24 * 60 * 60 * 1000) {
              await SummaryService.refreshSummaries();
            }
          } catch (err) {
            console.warn('[App] summary refresh failed:', err.message);
          }
        });

        // RAG embeddings are a Premium+ feature — skip entirely for free
        // tier. embedAllSessions() itself skips sessions already embedded,
        // so this is cheap on every launch after the first, and running it
        // after interactions finish keeps app startup from stalling on it.
        const tier = await TierService.getCachedTier();
        if (tier === 'premium' || tier === 'ultimate') {
          InteractionManager.runAfterInteractions(() => {
            EmbeddingService.embedAllSessions()
              .catch((err) => {
                console.warn('[App] background embedding failed:', err.message);
              })
              .finally(() => {
                // embedAllSessions() only recycles its llama.cpp context
                // every 15 sessions *during* the loop — with nothing left
                // to embed (the common case on every launch after the
                // first) that context stays resident indefinitely.
                // Chat's LocalAI then tries to load its own separate
                // context on top of it, which is exactly the kind of
                // two-context memory contention that's caused "Failed to
                // load model" elsewhere this session.
                EmbeddingService.release().catch(() => {});
              });
          });
        }

        // Warms weather_cache for the favourite beach before Weather (or
        // Chat, which grounds its prompt in today's cached weather) is ever
        // opened — non-blocking, and skipped entirely if today's cache is
        // already fresh (WeatherScreen re-checks staleness itself on open).
        if (favourite) {
          InteractionManager.runAfterInteractions(async () => {
            try {
              const today = new Date().toISOString().slice(0, 10);
              const cached = await WeatherRepository.getForBeach(favourite.name, today);
              if (!cached || isWeatherStale(cached)) {
                const forecast = await fetchBeachWeather(favourite);
                await WeatherRepository.cache(forecast);
                console.log('[App] Weather cached for today');
              }
            } catch (err) {
              console.warn('[App] background weather fetch failed:', err.message);
            }
          });
        }
      })
      .catch((err) => {
        console.error('[DB] Failed to initialise database', err);
      });
  }, []);

  if (!dbReady) {
    return (
      <SafeAreaProvider>
        <View style={styles.loading}>
          <Text style={{ color: colors.text }}>Loading…</Text>
          <StatusBar style="light" />
        </View>
      </SafeAreaProvider>
    );
  }

  if (!favouriteBeach) {
    return (
      <SafeAreaProvider>
        <View style={styles.loading}>
          <StatusBar style="light" />
        </View>
        <FavouriteBeachPicker visible onSelected={setFavouriteBeach} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="MainTabs" component={MainTabs} />
          <Stack.Screen
            name="ClipSelector"
            component={ClipSelectorScreen}
            options={{ gestureEnabled: false, animation: 'slide_from_bottom' }}
          />
          <Stack.Screen name="Upgrade" component={UpgradeScreen} options={{ presentation: 'modal' }} />
          <Stack.Screen name="SessionDetail" component={SessionDetailScreen} />
          <Stack.Screen name="ImportData" component={ImportDataScreen} />
          <Stack.Screen name="PeakMoment" component={PeakMomentScreen} />
          <Stack.Screen name="Stats" component={StatsScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
        </Stack.Navigator>
        <StatusBar style="light" />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: colors.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

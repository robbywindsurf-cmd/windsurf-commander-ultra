import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, InteractionManager } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDb, UserStore, TierService, EmbeddingService, WeatherRepository } from '@commandersuite/core';
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
        await Promise.all([seedEquipment(), seedBeaches()]);
        const favourite = await UserStore.getFavouriteBeach();
        setFavouriteBeach(favourite);
        setDbReady(true);

        // RAG embeddings are a Premium+ feature — skip entirely for free
        // tier. embedAllSessions() itself skips sessions already embedded,
        // so this is cheap on every launch after the first, and running it
        // after interactions finish keeps app startup from stalling on it.
        const tier = await TierService.getCachedTier();
        if (tier === 'premium' || tier === 'ultimate') {
          InteractionManager.runAfterInteractions(() => {
            EmbeddingService.embedAllSessions().catch((err) => {
              console.warn('[App] background embedding failed:', err.message);
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

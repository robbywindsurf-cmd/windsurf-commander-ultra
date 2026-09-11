import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { getDb } from '@commandersuite/core';
import { seedEquipment } from './src/utils/seedEquipment';

import HomeScreen from './src/screens/HomeScreen';
import WeatherScreen from './src/screens/WeatherScreen';
import SessionsScreen from './src/screens/SessionsScreen';
import VideoScreen from './src/screens/VideoScreen';
import GarageScreen from './src/screens/GarageScreen';
import ClipSelectorScreen from './src/screens/ClipSelectorScreen';
import UpgradeScreen from './src/screens/UpgradeScreen';
import SessionDetailScreen from './src/screens/SessionDetailScreen';
import { colors } from './src/theme';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TAB_META = {
  Home: { icon: '🏠', label: 'Home' },
  Weather: { icon: '🌊', label: 'Weather' },
  Sessions: { icon: '📅', label: 'Sessions' },
  Video: { icon: '🎬', label: 'Video' },
  Garage: { icon: '⚙️', label: 'Garage' },
};

function TabIcon({ routeName, focused }) {
  const meta = TAB_META[routeName] || { icon: '•', label: routeName };
  return (
    <View style={[tabStyles.pill, focused && tabStyles.pillActive]}>
      <Text style={tabStyles.emoji}>{meta.icon}</Text>
      <Text style={[tabStyles.label, focused && tabStyles.labelActive]}>{meta.label}</Text>
    </View>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: tabStyles.bar,
        tabBarItemStyle: tabStyles.item,
        tabBarIcon: ({ focused }) => <TabIcon routeName={route.name} focused={focused} />,
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Weather" component={WeatherScreen} />
      <Tab.Screen name="Sessions" component={SessionsScreen} />
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
    paddingVertical: 6, paddingHorizontal: 10,
    borderRadius: 9, minWidth: 54,
  },
  pillActive: {
    backgroundColor: colors.accent,
    shadowColor: colors.accent, shadowOpacity: 0.4,
    shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  emoji: { fontSize: 15, marginBottom: 2 },
  label: { fontSize: 9, fontWeight: '600', letterSpacing: 0.3, color: 'rgba(205,232,240,0.45)' },
  labelActive: { color: '#ffffff' },
});

export default function App() {
  const [dbReady, setDbReady] = useState(false);

  useEffect(() => {
    getDb()
      .then(async () => {
        console.log('[DB] Database initialised');
        await seedEquipment();
        setDbReady(true);
      })
      .catch((err) => {
        console.error('[DB] Failed to initialise database', err);
      });
  }, []);

  if (!dbReady) {
    return (
      <View style={styles.loading}>
        <Text style={{ color: colors.text }}>Loading…</Text>
        <StatusBar style="light" />
      </View>
    );
  }

  return (
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
      </Stack.Navigator>
      <StatusBar style="light" />
    </NavigationContainer>
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

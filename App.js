import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { getDb } from '@commandersuite/core';

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

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.deep, borderTopColor: 'rgba(26,138,181,0.2)' },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: 'rgba(205,232,240,0.4)',
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: '🏠 Home' }} />
      <Tab.Screen name="Weather" component={WeatherScreen} options={{ tabBarLabel: '🌊 Weather' }} />
      <Tab.Screen name="Sessions" component={SessionsScreen} options={{ tabBarLabel: '📅 Sessions' }} />
      <Tab.Screen name="Video" component={VideoScreen} options={{ tabBarLabel: '🎬 Video' }} />
      <Tab.Screen name="Garage" component={GarageScreen} options={{ tabBarLabel: '⚙️ Garage' }} />
    </Tab.Navigator>
  );
}

export default function App() {
  const [dbReady, setDbReady] = useState(false);

  useEffect(() => {
    getDb()
      .then(() => {
        console.log('[DB] Database initialised');
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
        <Stack.Screen name="ClipSelector" component={ClipSelectorScreen} />
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

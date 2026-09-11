import { StyleSheet, Text, View, Pressable } from 'react-native';
import { canAccess } from '@commandersuite/core';

// Mock user for the first device test — no Apple Sign In / RevenueCat flow
// wired up yet, so tier is hardcoded to 'free'.
const MOCK_USER = { nickname: 'Rob', tier: 'free' };

function testFeatureFlags() {
  const results = {
    VIDEO_IMPORT: canAccess('VIDEO_IMPORT', MOCK_USER.tier),
    FULL_ANALYSIS: canAccess('FULL_ANALYSIS', MOCK_USER.tier),
    CLOUD_RAG: canAccess('CLOUD_RAG', MOCK_USER.tier),
  };
  console.log('[FeatureFlags] VIDEO_IMPORT (free, expect true):', results.VIDEO_IMPORT);
  console.log('[FeatureFlags] FULL_ANALYSIS (premium, expect false):', results.FULL_ANALYSIS);
  console.log('[FeatureFlags] CLOUD_RAG (ultimate, expect false):', results.CLOUD_RAG);
}

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Windsurf Commander Ultra</Text>
      <Text style={styles.subtitle}>
        {MOCK_USER.nickname} · {MOCK_USER.tier} tier
      </Text>
      <Pressable style={styles.button} onPress={testFeatureFlags}>
        <Text style={styles.buttonText}>Test Feature Flags</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#666',
    marginBottom: 24,
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#1a73e8',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
});

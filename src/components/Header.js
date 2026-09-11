import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../theme';

export default function Header({ badge, title }) {
  return (
    <View style={styles.container}>
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: 18, paddingBottom: 8, paddingHorizontal: 12, backgroundColor: colors.deep },
  badge: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 4 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
});

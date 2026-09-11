import React from 'react';
import { View, StyleSheet } from 'react-native';

export default function SharedCard({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(26,138,181,0.06)',
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
    borderColor: 'rgba(26,138,181,0.12)',
    borderWidth: 1,
  },
});

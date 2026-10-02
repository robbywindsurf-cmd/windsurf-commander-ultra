import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';

// Renders as a plain container by default. Given onPress it becomes a button —
// used by the Weather screen's beach cards, which open that beach's detail.
export default function SharedCard({ children, style, onPress }) {
  if (onPress) {
    return (
      <TouchableOpacity activeOpacity={0.7} onPress={onPress} accessibilityRole="button" style={[styles.card, style]}>
        {children}
      </TouchableOpacity>
    );
  }
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

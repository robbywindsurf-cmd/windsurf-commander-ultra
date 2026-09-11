import React from 'react';
import { View, StyleSheet, TouchableOpacity, Text } from 'react-native';
import MapView, { Polyline } from 'react-native-maps';
import { toMapCoords, boundsRegion } from '../utils/geo';
import { colors } from '../theme';

// Small, non-interactive route preview for a session card. Tap anywhere on
// it to open the full-screen colour-coded map in SessionDetailScreen.
export default function SessionMapPreview({ trackpoints, onPress, height = 120 }) {
  const coords = toMapCoords(trackpoints, 80);
  const region = boundsRegion(coords);

  if (!region || coords.length < 2) {
    return (
      <View style={[styles.placeholder, { height }]}>
        <Text style={styles.placeholderText}>No GPS data</Text>
      </View>
    );
  }

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={[styles.wrap, { height }]}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        pointerEvents="none"
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        userInterfaceStyle="dark"
      >
        <Polyline coordinates={coords} strokeColor={colors.accent} strokeWidth={2.5} />
      </MapView>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 12, overflow: 'hidden', marginTop: 8 },
  placeholder: {
    borderRadius: 12, marginTop: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.15)',
  },
  placeholderText: { color: 'rgba(205,232,240,0.4)', fontSize: 12 },
});

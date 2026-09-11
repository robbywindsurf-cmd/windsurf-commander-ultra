import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MapView, { Polyline, Marker, Callout } from 'react-native-maps';
import { toMapCoords, boundsRegion, speedColor, findPeak } from '../utils/geo';

// Full-screen route map for SessionDetailScreen: the polyline is drawn as
// one segment per consecutive point pair so each segment can carry its own
// speed colour, a subsampled set of points are tappable (Callout shows
// speed), and the single fastest point gets a flag marker.
export default function SessionRouteMap({ trackpoints, height = 320 }) {
  const coords = toMapCoords(trackpoints, 1500);
  const region = boundsRegion(coords);
  const [selected, setSelected] = useState(null);

  if (!region || coords.length < 2) {
    return (
      <View style={[styles.placeholder, { height }]}>
        <Text style={styles.placeholderText}>No GPS data for this session</Text>
      </View>
    );
  }

  const peak = findPeak(coords);

  // Tappable waypoints — sampled so the map isn't covered in markers.
  const tapStride = Math.max(1, Math.floor(coords.length / 40));
  const tapPoints = coords.filter((_, i) => i % tapStride === 0);

  return (
    <View style={[styles.wrap, { height }]}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={region} userInterfaceStyle="dark">
        {coords.slice(1).map((point, i) => {
          const prev = coords[i];
          const avgSpeed =
            prev.speedKn != null && point.speedKn != null
              ? (prev.speedKn + point.speedKn) / 2
              : prev.speedKn ?? point.speedKn;
          return (
            <Polyline
              key={i}
              coordinates={[prev, point]}
              strokeColor={speedColor(avgSpeed)}
              strokeWidth={4}
            />
          );
        })}

        {tapPoints.map((p, i) => (
          <Marker
            key={i}
            coordinate={p}
            onPress={() => setSelected(p)}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={[styles.dot, { backgroundColor: speedColor(p.speedKn) }]} />
            <Callout>
              <Text style={styles.calloutText}>{p.speedKn != null ? `${p.speedKn.toFixed(1)} kn` : 'No speed data'}</Text>
            </Callout>
          </Marker>
        ))}

        {peak && (
          <Marker coordinate={peak} anchor={{ x: 0.5, y: 1 }}>
            <Text style={styles.flag}>🚩</Text>
            <Callout>
              <Text style={styles.calloutText}>Peak: {peak.speedKn.toFixed(1)} kn</Text>
            </Callout>
          </Marker>
        )}
      </MapView>

      <View style={styles.legend}>
        {[['<10kn', '#1a8ab5'], ['10-15kn', '#2a9d8f'], ['15-20kn', '#f4d35e'], ['>20kn', '#e63946']].map(([label, color]) => (
          <View key={label} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: color }]} />
            <Text style={styles.legendText}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 12, overflow: 'hidden' },
  placeholder: {
    borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.15)',
  },
  placeholderText: { color: 'rgba(205,232,240,0.4)', fontSize: 13 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: '#fff' },
  flag: { fontSize: 22 },
  calloutText: { fontSize: 12, fontWeight: '600', color: '#061f2e' },
  legend: {
    position: 'absolute', bottom: 8, left: 8, right: 8,
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: 'rgba(6,31,46,0.75)', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 8,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: '#cde8f0', fontSize: 10 },
});

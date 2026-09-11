// geo.js — shared helpers for turning trackpoint rows into map-ready data:
// coordinate normalisation, bounding-box regions, speed colour coding, and
// even subsampling so long sessions don't render thousands of map elements.

const MPS_TO_KN = 1.94384;

// Blue <10kn, Green 10-15kn, Yellow 15-20kn, Red >20kn.
export function speedColor(speedKn) {
  if (speedKn == null) return '#888888';
  if (speedKn > 20) return '#e63946';
  if (speedKn > 15) return '#f4d35e';
  if (speedKn > 10) return '#2a9d8f';
  return '#1a8ab5';
}

function subsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

// Converts trackpoint rows (lat/lon/speed_ms) into map coordinates with
// speed in knots, dropping rows with no GPS fix, evenly subsampled to
// maxPoints so previews/full maps stay cheap to render.
export function toMapCoords(trackpoints, maxPoints = 1500) {
  const valid = (trackpoints || [])
    .filter((t) => t.lat != null && t.lon != null)
    .map((t) => ({
      latitude: t.lat,
      longitude: t.lon,
      speedKn: t.speed_ms != null ? Math.round(t.speed_ms * MPS_TO_KN * 10) / 10 : null,
      timestamp: t.timestamp,
    }));
  return subsample(valid, maxPoints);
}

export function boundsRegion(coords, paddingFactor = 1.4) {
  if (!coords.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const c of coords) {
    if (c.latitude < minLat) minLat = c.latitude;
    if (c.latitude > maxLat) maxLat = c.latitude;
    if (c.longitude < minLon) minLon = c.longitude;
    if (c.longitude > maxLon) maxLon = c.longitude;
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * paddingFactor, 0.006),
    longitudeDelta: Math.max((maxLon - minLon) * paddingFactor, 0.006),
  };
}

export function findPeak(coords) {
  let peak = null;
  for (const c of coords) {
    if (c.speedKn != null && (!peak || c.speedKn > peak.speedKn)) peak = c;
  }
  return peak;
}

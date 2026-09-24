# Sailing Analytics — Calculations Reference

This documents the exact formulas behind the "Sailing Analytics (estimated)"
section on a session's detail screen: wind direction, tacks/gybes, and VMG.
Written for independent review — every formula below is copied directly
from the source, with file/line references, not reconstructed from memory.

**Important context up front:** none of this comes from a wind sensor,
compass, or IMU. The device only ever records GPS position, timestamp, and
(sometimes) speed. Every figure below is *inferred* from the shape of the
GPS track — course-over-ground and how it changes over time — and every
result the app shows carries an "estimated" label and a disclaimer for
exactly that reason.

---

## 1. Course (heading) — `bearingDeg()`

**File:** `windsurf-commander-ultra/src/services/FITImporter.js:106-114`

Most windsurfing GPS watches don't record a heading/course field at all, so
it's derived from two consecutive GPS fixes using the standard
initial-bearing (forward azimuth) formula:

```
θ = atan2(sin(Δlon)·cos(lat2), cos(lat1)·sin(lat2) − sin(lat1)·cos(lat2)·cos(Δlon))
course = (θ in degrees + 360) mod 360
```

- `lat1, lon1` = previous GPS point; `lat2, lon2` = current point.
- Result is 0-360°, compass bearing (0° = due north, 90° = east, etc.),
  **direction of travel**, not wind direction.
- Only computed when the FIT file didn't already provide a `course`/
  `heading` field, and only between two consecutive points that aren't at
  the same position (avoids a divide-by-zero/undefined bearing when
  stationary).

```js
function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
```

## 2. Distance / speed between points — `haversineMeters()`

**File:** `FITImporter.js:60-69`

Standard great-circle (haversine) distance, used both to derive speed when
a device didn't record it, and to compute session distance from the raw
track:

```
a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)
distance = 2 · R · asin(√a)        where R = 6,371,000 m (Earth radius)
```

Speed, where needed, is then simply `distance ÷ Δt` between the
surrounding two points (`FITImporter.js:71-96`).

---

## 3. Wind direction estimate — `WindEstimator.estimateFromTrackpoints()`

**File:** `commander-core/src/analysis/WindEstimator.js`

**The core assumption:** a rider beating upwind alternates between two
roughly symmetric headings (port tack / starboard tack) either side of the
true wind axis. The estimator searches for the wind direction that best
explains the *shape* of the observed course data as a genuine beat, rather
than a reach or a straight run.

**Method:**

1. Filter to points with `speed ≥ 8 kn` (default `minSpeedKn`) — course is
   noisy/unreliable at low speed (drifting, waiting). Requires **20+**
   qualifying points or returns `confidence: 'none'`.
2. For every candidate wind-from direction, stepping in **5°** increments
   from 0-360°:
   - For each point, compute `TWA = angularDiff(course, windFrom)` — the
     angular difference between the rider's course and that candidate wind
     direction (0-180°, always positive; see helper below).
   - Only count points where `30° ≤ TWA ≤ 60°` (`BEAT_TWA_MIN`/`_MAX`) —
     the "beating band," the range windsurfers actually beat upwind in.
   - Classify each counted point as **port** or **starboard** tack using
     the *signed* angular difference from the candidate wind direction to
     the course (positive = starboard side, negative = port side).
3. Score each candidate: `score = total_count × balance`, where
   `balance = 1 − |port_count − starboard_count| / total_count`
   (1.0 = perfectly even split between tacks, 0 = all one side — a lopsided
   cluster is more likely a reach than genuine beating).
4. Pick the candidate with the highest score. Requires **10+** points in
   its beating band, or returns `confidence: 'none'`.
5. Confidence label:
   - **high**: ≥60 beating-band points AND balance ≥ 0.6
   - **medium**: ≥25 points AND balance ≥ 0.4
   - **low**: anything else that still passed the minimum-10 threshold

```js
function angularDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}
// Signed difference from `from` to `to`, in (-180, 180], positive = clockwise.
function signedAngularDiff(from, to) {
  let d = (to - from + 540) % 360 - 180;
  return d;
}
```

**Output:** `windFromDeg` (the direction the wind is blowing *from*, 0-360°),
`confidence`, sample counts, and `tackBalance`. Returns `windFromDeg: null`
if no clear beating pattern was found — every downstream calculation
(manoeuvres, VMG) degrades gracefully when this happens (see below).

---

## 4. Tacks and gybes — `ManoeuvreDetector.detect()`

**File:** `commander-core/src/analysis/ManoeuvreDetector.js`

**Definition used:** a manoeuvre is a course change of at least
**60°** (`TURN_THRESHOLD_DEG`) completed within a trailing **15-second**
window (`TURN_WINDOW_S`), at **≥5 kn** (`MIN_SPEED_KN`, filters out
low-speed course noise), with at least **8 seconds** since the last
detected manoeuvre (`MIN_GAP_BETWEEN_MANOEUVRES_S`, avoids double-counting
one turn as several).

**Method, per point (moving forward in time):**

1. Look back from the current point to find the earliest point still
   within the trailing 15-second window.
2. `change = angularDiff(course at window start, course now)`.
3. If `change < 60°`, not a manoeuvre — skip.
4. If less than 8s since the last detected manoeuvre — skip (debounce).
5. Otherwise, classify using the wind estimate from Section 3
   (`TWA = angularDiff(course, windFromDeg)` at both the start and end of
   the turn):
   - **Tack**: `TWA < 90°` both before *and* after the turn (upwind → upwind).
   - **Gybe**: `TWA ≥ 90°` both before *and* after (downwind → downwind).
   - **Uncategorised**: crosses from upwind to downwind (or vice versa),
     or no wind estimate is available at all — deliberately left
     unclassified rather than guessed, since a turn that crosses the
     upwind/downwind boundary isn't a tack or a gybe in the sailing sense.

**Output:** counts (`tacks`, `gybes`, `uncategorised`, `total`) and a list
of individual manoeuvres with timestamp, before/after course, and speed.

---

## 5. VMG (Velocity Made Good) — `AnalyticsService.computeVMG()` / `summarizeVMG()`

**File:** `commander-core/src/analysis/AnalyticsService.js`

**Definition used — standard sailing VMG:** the component of boat speed
directed straight upwind (toward the wind source) or straight downwind
(away from it).

```
TWA = angularDiff(course, windFromDeg)      // 0° = pointing straight into the wind
VMG = speed × cos(TWA)
```

- At `TWA < 90°` (upwind), VMG is positive — genuine progress upwind.
- At `TWA > 90°` (downwind), the same formula goes negative (heading away
  from the wind source); the app reports downwind VMG as the **positive
  magnitude** (`-vmgKn`) for readability, since "negative progress
  downwind" reads as nonsensical to a rider even though it's
  mathematically correct.
- Requires a wind direction estimate (Section 3) — returns an empty array
  if none was available.

**Summary figures shown on the session screen** (`summarizeVMG()`):

| Field | Meaning |
|---|---|
| `bestUpwindVMGKn` | Max VMG among all samples with `TWA < 90°` |
| `avgUpwindVMGKn` | Mean VMG among all samples with `TWA < 90°` |
| `bestDownwindVMGKn` | Max *magnitude* of VMG among samples with `TWA ≥ 90°` |
| `avgDownwindVMGKn` | Mean *magnitude* of VMG among samples with `TWA ≥ 90°` |

Speed is converted from the FIT file's native m/s to knots throughout
using `MS_TO_KN = 1.94384`.

---

## Known limitations (already flagged in the code/UI, listed here for completeness)

- **No wind sensor** — wind direction is inferred from tacking geometry
  only. A session with too little clean beating (e.g. mostly reaching, or
  under 20 fast GPS points) returns no wind estimate at all, and
  everything downstream of it (manoeuvre classification, VMG) is either
  blank or left uncategorised rather than guessed.
- **Course itself is GPS-derived**, not from a compass/IMU — subject to
  ordinary GPS noise, more so at low speed (hence the speed filters in
  both `WindEstimator` and `ManoeuvreDetector`).
- Manoeuvre and wind-direction thresholds (60° turn / 15s window / 5kn
  minimum / 8-60° beat band, etc.) are fixed constants tuned by inspection,
  not derived from a written specification — flagged explicitly in each
  file's header comment as "no spec was provided for this."

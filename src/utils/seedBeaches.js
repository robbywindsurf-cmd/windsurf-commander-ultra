// seedBeaches.js
// Default beach catalogue (South West England) offered in the Weather
// screen's picker and the favourite-beach picker. Coordinates are
// approximate, close enough for Open-Meteo's grid resolution. Seeded once
// on app launch — BeachRepository.seedDefaults() is INSERT OR IGNORE, so
// this is a no-op on every subsequent launch.

import { BeachRepository } from '@commandersuite/core';

// Full guide data (wind directions, ideal range, waves, tides, hazards,
// notes) is filled in for the beaches Rob actually sails and has a real
// guide for — the rest of the catalogue stays name/coords-only, same as
// before, since there's no real guide content for them yet. Coordinates
// are only changed where explicitly flagged as wrong (Torpoint) — the
// other guide beaches' lat/lon here matched what was already seeded
// closely enough that overwriting them wasn't called for.
export const ALL_BEACHES = [
  {
    name: 'Torpoint', emoji: '🎯', lat: 50.37154, lon: -4.1908264, sort_order: 0,
    aka: "St John's Lake",
    wind_dirs_good: 'SW, WSW, W, WNW, NW',
    wind_dirs_avoid: 'N, NE, E, SE',
    ideal_wind_kn_min: 12,
    ideal_wind_kn_max: 28,
    max_wave_m: 0.4,
    break_type: 'flat_water',
    tidal_notes: 'Best at mid-high tide. Low tide exposes mud flats. Tidal range ~4m — check before launch.',
    hazards: 'Shipping channel — stay clear of ferries and naval vessels. Mud at low tide.',
    notes: 'Flat water speed sailing venue. Sheltered estuary. Good for freeride and speed. WNW winds can be gusty off the hills.',
  },
  {
    name: 'Bigbury on Sea', emoji: '🌊', lat: 50.2822, lon: -3.8905, sort_order: 1,
    wind_dirs_good: 'W, NW, SW',
    wind_dirs_avoid: 'E, SE',
    ideal_wind_kn_min: 15,
    ideal_wind_kn_max: 30,
    max_wave_m: 2.0,
    break_type: 'beach_waves',
    tidal_notes: 'Access to Burgh Island at low tide. Good at all tides for windsurfing.',
    hazards: 'Rocks around Burgh Island. Swimmers in summer.',
    notes: 'Open Atlantic swell exposure. Good wave sailing in SW winds.',
  },
  {
    name: 'Daymer Bay', emoji: '⚠️', lat: 50.5462, lon: -4.8371, sort_order: 2,
    wind_dirs_good: 'SW, W, NW, N',
    wind_dirs_avoid: 'E, SE',
    ideal_wind_kn_min: 12,
    ideal_wind_kn_max: 25,
    max_wave_m: 0.5,
    break_type: 'estuary',
    tidal_notes: 'Camel Estuary — best at mid tide. Very shallow at low tide.',
    hazards: 'Sandbanks, shallow water. Padstow harbour traffic.',
    notes: 'Sheltered estuary sailing. Good for beginners and light wind. Padstow across the water.',
  },
  {
    name: 'Marazion Beach', emoji: '🏰', lat: 50.1258, lon: -5.4756, sort_order: 3,
    wind_dirs_good: 'N, NE, NW',
    wind_dirs_avoid: 'S, SW, SE',
    ideal_wind_kn_min: 12,
    ideal_wind_kn_max: 25,
    max_wave_m: 0.8,
    break_type: 'beach',
    tidal_notes: "Mount's Bay — good at all tides. More water at high tide near beach.",
    hazards: "Rocks near St Michael's Mount. Tourist boats in summer.",
    notes: "Mount's Bay. Views of St Michael's Mount. Offshore winds from N-NE give flat water. Can get choppy in S winds.",
  },
  {
    name: 'Plymouth Sound', emoji: '⚓', lat: 50.3468, lon: -4.1447, sort_order: 4,
    aka: 'Mount Batten',
    wind_dirs_good: 'SW, W, NW, S',
    wind_dirs_avoid: 'E, NE',
    ideal_wind_kn_min: 12,
    ideal_wind_kn_max: 25,
    max_wave_m: 0.3,
    break_type: 'flat_water',
    tidal_notes: 'Plymouth Sound — sheltered at all tides.',
    hazards: 'Ferry routes — Brittany Ferries. Naval vessels. Shipping channel — stay clear. Wind can be understated here in E winds (sheltered by land).',
    notes: 'Wind data from Mount Batten weather station. Sheltered from easterlies — recorded wind may be understated 30-50% in E winds. Good flat water venue.',
  },
  {
    name: 'Par Beach', emoji: '🏖️', lat: 50.3487, lon: -4.7024, sort_order: 5,
    wind_dirs_good: 'N, NE, NW',
    wind_dirs_avoid: 'S, SW',
    ideal_wind_kn_min: 12,
    ideal_wind_kn_max: 25,
    max_wave_m: 1.0,
    break_type: 'beach',
    tidal_notes: 'St Austell Bay. Good at all tides.',
    hazards: 'China clay port nearby. Industrial shipping.',
    notes: 'St Austell Bay venue. N-NE winds give offshore conditions.',
  },
  { name: 'Mothecombe', emoji: '🌿', lat: 50.3010, lon: -3.9575, sort_order: 6 },
  { name: 'Whitsands', emoji: '🪖', lat: 50.3376, lon: -4.2478, sort_order: 7 },
  { name: 'Slapton Sands', emoji: '🏝️', lat: 50.2814, lon: -3.6479, sort_order: 8 },
  { name: 'Wembury', emoji: '🐚', lat: 50.3138, lon: -4.0855, sort_order: 9 },
  { name: 'Thurlestone', emoji: '🪨', lat: 50.2665, lon: -3.8590, sort_order: 10 },
  { name: 'Siblyback Lake', emoji: '🏞️', lat: 50.4926, lon: -4.4693, sort_order: 11 },
  { name: 'Coverack', emoji: '🎣', lat: 50.0295, lon: -5.0995, sort_order: 12 },
  { name: 'Poole Harbour', emoji: '⛵', lat: 50.7000, lon: -1.9700, sort_order: 13 },
  { name: 'Weymouth Portland Harbour', emoji: '🚀', lat: 50.6047, lon: -2.4517, sort_order: 14 },
  { name: 'Paignton', emoji: '🎡', lat: 50.4333, lon: -3.5667, sort_order: 15 },
];

export async function seedBeaches() {
  await BeachRepository.seedDefaults(ALL_BEACHES);
}

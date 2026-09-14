// seedBeaches.js
// Default beach catalogue (South West England) offered in the Weather
// screen's picker and the favourite-beach picker. Coordinates are
// approximate, close enough for Open-Meteo's grid resolution. Seeded once
// on app launch — BeachRepository.seedDefaults() is INSERT OR IGNORE, so
// this is a no-op on every subsequent launch.

import { BeachRepository } from '@commandersuite/core';

export const ALL_BEACHES = [
  { name: 'Torpoint', emoji: '🎯', lat: 50.3833, lon: -4.1833, sort_order: 0 },
  { name: 'Bigbury on Sea', emoji: '🌊', lat: 50.2822, lon: -3.8905, sort_order: 1 },
  { name: 'Daymer Bay', emoji: '⚠️', lat: 50.5462, lon: -4.8371, sort_order: 2 },
  { name: 'Marazion Beach', emoji: '🏰', lat: 50.1258, lon: -5.4756, sort_order: 3 },
  { name: 'Plymouth Sound', emoji: '⚓', lat: 50.3468, lon: -4.1447, sort_order: 4 },
  { name: 'Par Beach', emoji: '🏖️', lat: 50.3487, lon: -4.7024, sort_order: 5 },
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

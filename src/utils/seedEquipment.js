// seedEquipment.js
// One-time seed of Rob's real quiver (from the production Oracle database)
// into the local SQLite equipment/gear_combos tables. Runs once on app
// launch — checks the equipment table is empty first, so it's a no-op on
// every subsequent launch.

import { getDb, EquipmentRepository } from '@commandersuite/core';

const BOARDS = [
  { brand: 'Severne', name: 'Fox', volume_l: 120, width_cm: 70, year: 2022, active: 1 },
  { brand: 'Exocet', name: 'Cross', volume_l: 104, width_cm: 64, year: 2025, active: 1 },
  { brand: 'Starboard', name: 'Kombat', volume_l: 87, width_cm: 59, year: 2005, active: 1 },
  { brand: 'AHD', name: 'Sealion', volume_l: 125, width_cm: 76, year: 2022, active: 1 },
  { brand: 'Goya', name: 'One', volume_l: 102, width_cm: 63, year: 2011, active: 0 },
  { brand: 'JP Australia', name: 'SuperSport', volume_l: 127, width_cm: 74, year: 2011, active: 0 },
];

// Cosmic and Manic each come in two sizes, so the size is folded into the
// name to keep it unique — everything else (Addict, Venture, Storm, Rock)
// only has one size in the quiver.
const SAILS = [
  { brand: 'Gaastra', name: 'Cosmic 7.5', size: '7.5', notes: '2 Cam Freerace', active: 1 },
  { brand: 'Gaastra', name: 'Cosmic 6.7', size: '6.7', notes: '2 Cam Freerace', active: 1 },
  { brand: 'Gaastra', name: 'Manic 5.7', size: '5.7', notes: 'Wave', active: 1 },
  { brand: 'Gaastra', name: 'Manic 5.3', size: '5.3', notes: 'Wave', active: 1 },
  { brand: 'Vandal', name: 'Addict', size: '6.5', notes: 'Hybrid', active: 1 },
  { brand: 'Vandal', name: 'Venture', size: '5.8', notes: 'Hybrid', active: 1 },
  { brand: 'Tushingham', name: 'Storm', size: '4.8', notes: 'Wave', active: 1 },
  { brand: 'Tushingham', name: 'Rock', size: '4.2', notes: 'Wave', active: 1 },
];

const FINS = [
  { brand: 'K4', name: '3SW', size: '28', fin_type: 'Wave', notes: null, active: 1 },
  { brand: 'Northshore', name: 'Bjorn Dunkerbeck', size: '32', fin_type: 'Freestyle', notes: 'Powerbox', active: 1 },
  { brand: 'MFC', name: 'Liquid Pro 420', size: '42', fin_type: 'Freeride', notes: 'Powerbox', active: 1 },
  { brand: 'MFC', name: 'Liquid Pro 38', size: '38', fin_type: 'Freeride', notes: 'Powerbox', active: 1 },
  { brand: 'SV', name: 'F-Series', size: '42', fin_type: 'Freeride', notes: 'Powerbox', active: 1 },
  { brand: 'Severne', name: 'Freeride', size: '40', fin_type: 'Freeride', notes: 'Powerbox', active: 1 },
  { brand: 'Drake', name: 'Cross 240', size: '24', fin_type: 'Freestyle-hybrid', notes: 'US Box', active: 1 },
  { brand: 'AHD', name: 'Sealion 19', size: '19', fin_type: 'Freestyle-hybrid', notes: 'US Box', active: 1 },
];

// board/sail refer to the equipment names above.
const COMBOS = [
  { board: 'Fox', sail: 'Cosmic 7.5', category: 'Flat water blasting', wind_min_kn: 11, wind_max_kn: 17, wave_min_m: 0, wave_max_m: 0.3, notes: 'PB combo 27.3 knots 5 Nov 2023. FLAT WATER ONLY.' },
  { board: 'Fox', sail: 'Cosmic 6.7', category: 'Flat water blasting', wind_min_kn: 17, wind_max_kn: 24, wave_min_m: 0, wave_max_m: 0.3, notes: 'FLAT WATER ONLY.' },
  { board: 'Fox', sail: 'Venture', category: 'Flat water blasting', wind_min_kn: 24, wind_max_kn: 28, wave_min_m: 0, wave_max_m: 0.3, notes: 'FLAT WATER ONLY.' },
  { board: 'Cross', sail: 'Addict', category: 'Flat/Bump&Jump/Small Waves', wind_min_kn: 17, wind_max_kn: 24, wave_min_m: 0, wave_max_m: 1.0, notes: null },
  { board: 'Cross', sail: 'Venture', category: 'Flat/Bump&Jump/Small Waves', wind_min_kn: 24, wind_max_kn: 28, wave_min_m: 0, wave_max_m: 1.0, notes: null },
  { board: 'Cross', sail: 'Storm', category: 'Flat/Bump&Jump/Small Waves', wind_min_kn: 25, wind_max_kn: 30, wave_min_m: 0, wave_max_m: 1.0, notes: null },
  { board: 'Cross', sail: 'Rock', category: 'Flat/Bump&Jump/Small Waves', wind_min_kn: 17, wind_max_kn: 24, wave_min_m: 0, wave_max_m: 1.0, notes: null },
  { board: 'Kombat', sail: 'Venture', category: 'Flat/Bump&Jump/Small Waves', wind_min_kn: 24, wind_max_kn: 28, wave_min_m: 0, wave_max_m: 1.5, notes: null },
  { board: 'Kombat', sail: 'Storm', category: 'Flat/Bump&Jump/Small Waves', wind_min_kn: 25, wind_max_kn: 30, wave_min_m: 0, wave_max_m: 1.5, notes: null },
  { board: 'Kombat', sail: 'Manic 5.3', category: 'Flat/Bump&Jump/Small Waves', wind_min_kn: 22, wind_max_kn: 27, wave_min_m: 0, wave_max_m: 1.5, notes: null },
  { board: 'Kombat', sail: 'Rock', category: 'Flat/Small Waves', wind_min_kn: 17, wind_max_kn: 24, wave_min_m: 0, wave_max_m: 1.5, notes: null },
  { board: 'Sealion', sail: 'Rock', category: 'Light wind/Flat', wind_min_kn: 5, wind_max_kn: 11, wave_min_m: 0, wave_max_m: 0.5, notes: 'ONLY below 12kts. Always use Sealion for sub-12kt conditions.' },
  { board: 'Sealion', sail: 'Addict', category: 'Flat/Small Waves', wind_min_kn: 17, wind_max_kn: 24, wave_min_m: 0, wave_max_m: 0.5, notes: 'Practice board' },
  { board: 'Sealion', sail: 'Venture', category: 'Flat/Small Waves', wind_min_kn: 24, wind_max_kn: 28, wave_min_m: 0, wave_max_m: 0.5, notes: null },
  { board: 'Sealion', sail: 'Storm', category: 'Flat/Small Waves', wind_min_kn: 25, wind_max_kn: 30, wave_min_m: 0, wave_max_m: 0.5, notes: null },
];

export async function seedEquipment() {
  const db = await getDb();

  const row = await db.getFirstAsync('SELECT COUNT(*) as count FROM equipment');
  if (row?.count > 0) {
    return; // already seeded
  }

  for (const b of BOARDS) {
    await EquipmentRepository.insert({ type: 'board', ...b });
  }
  for (const s of SAILS) {
    await EquipmentRepository.insert({ type: 'sail', ...s });
  }
  for (const f of FINS) {
    await EquipmentRepository.insert({ type: 'fin', ...f });
  }

  // Look combo board/sail names up by id now that everything's inserted —
  // getGearCombos() joins on these ids, not on name.
  const boards = await EquipmentRepository.getAll('board', { includeInactive: true });
  const sails = await EquipmentRepository.getAll('sail', { includeInactive: true });
  const boardId = (name) => boards.find((b) => b.name === name)?.id ?? null;
  const sailId = (name) => sails.find((s) => s.name === name)?.id ?? null;

  for (const c of COMBOS) {
    await EquipmentRepository.insertGearCombo({
      name: `${c.board} + ${c.sail}`,
      board_id: boardId(c.board),
      sail_id: sailId(c.sail),
      fin_id: null,
      notes: c.notes,
      category: c.category,
      wind_min_kn: c.wind_min_kn,
      wind_max_kn: c.wind_max_kn,
      wave_min_m: c.wave_min_m,
      wave_max_m: c.wave_max_m,
    });
  }

  console.log('[Seed] Equipment seeded successfully');
}

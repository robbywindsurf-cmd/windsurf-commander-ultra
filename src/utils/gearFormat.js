// gearFormat.js — one quiver combo as the rider reads it.
//
// Shared so the beach cards, the beach detail's kit recommendation and the AI's
// own gear context all describe a combo the same way. They previously each
// built their own string, and all of them dropped the fin.
//
// Boards are sized in litres, sails in m², fins in cm — all stored as TEXT on
// `equipment`, and often blank — so each size is only appended when present.
export function formatGearCombo(combo) {
  if (!combo) return null;

  const parts = [
    [combo.board_name, combo.board_size ? `${combo.board_size}L` : null],
    [combo.sail_name,  combo.sail_size  ? `${combo.sail_size}m`  : null],
    [combo.fin_name,   combo.fin_size   ? `${combo.fin_size}cm`  : null],
  ]
    .map((p) => p.filter(Boolean).join(' '))
    .filter(Boolean);

  // A combo saved without named gear still has whatever the rider called it.
  return parts.join(' + ') || combo.name || null;
}

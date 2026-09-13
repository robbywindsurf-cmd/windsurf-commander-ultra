import { getDb } from './schema';

// Finds an equipment row by type + name + size, creating it if it doesn't
// exist yet ("garage" grows automatically as historical CSVs are imported).
export async function findOrCreateEquipment(type, name, brand, size) {
  if (!name) return null;
  const db = getDb();

  const existing = await db.getFirstAsync(
    'SELECT id FROM equipment WHERE type = ? AND name = ? AND IFNULL(size, "") = IFNULL(?, "")',
    [type, name, size ?? null]
  );
  if (existing) return existing.id;

  const result = await db.runAsync(
    'INSERT INTO equipment (type, name, brand, size) VALUES (?, ?, ?, ?)',
    [type, name, brand ?? null, size ?? null]
  );
  return result.lastInsertRowId;
}

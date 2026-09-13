import * as SQLite from 'expo-sqlite';

let db = null;

export function getDb() {
  if (!db) {
    db = SQLite.openDatabaseSync('windsurf_commander.db');
  }
  return db;
}

export async function initDb() {
  const database = getDb();
  await database.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      notes TEXT,
      date TEXT,
      start_time TEXT,
      end_time TEXT,
      duration_s INTEGER,
      max_speed_kn REAL,
      avg_speed_kn REAL,
      total_trackpoints INTEGER,
      board_id INTEGER,
      sail_id INTEGER,
      fin_name TEXT,
      fin_size TEXT,
      wind_speed REAL,
      wind_direction TEXT,
      temperature REAL,
      lat REAL,
      lon REAL,
      session_type TEXT,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT,
      size TEXT,
      UNIQUE(type, name, size)
    );
  `);

  // Column-add migration for DBs created before lat/lon existed.
  const columns = await database.getAllAsync('PRAGMA table_info(sessions)');
  const columnNames = columns.map((c) => c.name);
  if (!columnNames.includes('lat')) {
    await database.execAsync('ALTER TABLE sessions ADD COLUMN lat REAL');
  }
  if (!columnNames.includes('lon')) {
    await database.execAsync('ALTER TABLE sessions ADD COLUMN lon REAL');
  }

  return database;
}

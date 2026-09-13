import { getDb } from './schema';

export async function sessionExists(sessionId) {
  const db = getDb();
  const row = await db.getFirstAsync('SELECT 1 FROM sessions WHERE session_id = ?', [sessionId]);
  return !!row;
}

export async function insertSession(session) {
  const db = getDb();
  await db.runAsync(
    `INSERT INTO sessions (
      session_id, notes, date, start_time, end_time, duration_s,
      max_speed_kn, avg_speed_kn, total_trackpoints,
      board_id, sail_id, fin_name, fin_size,
      wind_speed, wind_direction, temperature, lat, lon, session_type, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.session_id,
      session.notes ?? null,
      session.date ?? null,
      session.start_time ?? null,
      session.end_time ?? null,
      session.duration_s ?? null,
      session.max_speed_kn ?? null,
      session.avg_speed_kn ?? null,
      session.total_trackpoints ?? null,
      session.board_id ?? null,
      session.sail_id ?? null,
      session.fin_name ?? null,
      session.fin_size ?? null,
      session.wind_speed ?? null,
      session.wind_direction ?? null,
      session.temperature ?? null,
      session.lat ?? null,
      session.lon ?? null,
      session.session_type ?? null,
      'csv_import',
    ]
  );
}

export async function getLocalSessions() {
  const db = getDb();
  return db.getAllAsync(`
    SELECT
      s.session_id,
      s.notes            AS session_name,
      s.date             AS session_date,
      s.start_time,
      s.end_time,
      s.duration_s / 60.0 AS duration_minutes,
      s.max_speed_kn      AS peak_speed_knots,
      s.avg_speed_kn      AS avg_speed_knots,
      s.total_trackpoints,
      b.name              AS board_name,
      b.size              AS board_size,
      sa.name             AS sail_name,
      sa.size             AS sail_size,
      s.fin_name,
      s.fin_size,
      s.wind_speed,
      s.wind_direction,
      s.temperature,
      s.lat,
      s.lon,
      s.session_type,
      s.source
    FROM sessions s
    LEFT JOIN equipment b  ON b.id  = s.board_id
    LEFT JOIN equipment sa ON sa.id = s.sail_id
    ORDER BY s.date DESC
  `);
}

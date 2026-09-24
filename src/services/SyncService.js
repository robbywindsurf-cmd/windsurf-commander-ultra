// SyncService.js — pushes local sessions up to Oracle Postgres, one-way
// (phone writes, Oracle reads — no conflict resolution needed for this
// direction). Requires both SiteAuthService (site-wide Basic Auth) and
// IdentityService (reference-key identity, resolves to a real Oracle
// user_id) to already be unlocked — both patch global fetch, so this
// service doesn't need to handle either header itself.
//
// Needs the windsurf-sync-session n8n workflow to exist on Oracle (new,
// not yet built as of writing this) — see
// commander-core/WINDSURF_COMMANDER_ULTRA_HANDOVER.md Section 3 for the
// exact contract this posts against.
import { SessionRepository } from '@commandersuite/core';

const SYNC_URL = 'https://windsurf.surfkat.co.uk/webhook/windsurf-sync-session';

function toPayload(session) {
  return {
    session_id: session.session_id,
    session_date: session.date,
    start_time: session.start_time,
    end_time: session.end_time,
    duration_minutes: session.duration_s != null ? Math.round(session.duration_s / 60) : null,
    rep_lat: session.lat,
    rep_lon: session.lon,
    session_type: session.sport,
    session_name: session.notes,
    board_name: session.board_name,
    board_brand: session.board_brand,
    board_size: session.board_size,
    sail_name: session.sail_name,
    sail_brand: session.sail_brand,
    sail_size: session.sail_size,
    fin_name: session.fin_name,
    fin_size: session.fin_size,
    peak_speed_knots: session.max_speed_kn,
    avg_speed_knots: session.avg_speed_kn,
    hr_avg: session.avg_hr,
    hr_max: session.max_hr,
    calories: session.calories,
    total_trackpoints: session.trackpoint_count,
    appro_dist_km: session.distance_m != null ? Math.round(session.distance_m) / 1000 : null,
  };
}

export const SyncService = {
  async countUnsynced() {
    const rows = await SessionRepository.getUnsynced();
    return rows.length;
  },

  // Recovery from a bad sync run that marked sessions synced without
  // actually writing them to Oracle (see the res.ok check above).
  async resetSyncState() {
    await SessionRepository.resetSyncState();
  },

  // Pushes every unsynced session, one at a time (so a single bad row
  // doesn't abort the whole batch) — onProgress(completed, total) after
  // each. Returns { success, count, errors }, same shape as the other
  // backfill services in this app.
  async syncSessions(onProgress) {
    const sessions = await SessionRepository.getUnsyncedWithGear();
    const total = sessions.length;
    let completed = 0;
    let count = 0;
    const errors = [];

    for (const session of sessions) {
      completed += 1;
      try {
        const res = await fetch(SYNC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toPayload(session)),
        });
        const text = await res.text().catch(() => '');
        // n8n can respond 200 with an error body when a workflow throws
        // before reaching its "Respond to Webhook" node — checking res.ok
        // alone isn't enough, a 200 here isn't proof the row was actually
        // written. Only the exact session_id echoed back counts as real
        // confirmation.
        let data = null;
        try { data = JSON.parse(text); } catch { /* not JSON — definitely not success */ }
        if (!res.ok || !data || data.session_id !== session.session_id) {
          throw new Error((data && (data.error || data.errorMessage)) || text || `Sync error ${res.status}`);
        }
        await SessionRepository.markSynced(session.session_id);
        count += 1;
      } catch (err) {
        errors.push({ sessionId: session.session_id, message: err.message });
      }
      onProgress?.(completed, total);
    }

    return { success: errors.length === 0, count, errors };
  },
};

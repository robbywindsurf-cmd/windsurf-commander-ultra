import { SessionRepository, TrackpointRepository } from '@commandersuite/core';

// Sessions imported via the historical Oracle CSV never get avg_hr/max_hr
// set on the sessions row itself (only FITImporter's watch-file path does)
// — even when the separate trackpoints CSV import already carries
// per-point hr for the same session_id. This aggregates trackpoints.hr
// back onto sessions.avg_hr/max_hr wherever it's missing, so the AI
// (PromptBuilder/EmbeddingService, both already HR-aware) has something to
// read for CSV-imported sessions.
export const HrBackfillService = {
  async countMissing() {
    const sessions = await SessionRepository.getAll();
    return sessions.filter((s) => s.avg_hr == null && s.max_hr == null).length;
  },

  async backfillAllSessions(onProgress) {
    const sessions = await SessionRepository.getAll();
    const total = sessions.length;
    let completed = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const session of sessions) {
      completed += 1;
      try {
        if (session.avg_hr == null && session.max_hr == null) {
          const stats = await TrackpointRepository.getHrStats(session.session_id);
          if (stats) {
            await SessionRepository.updateHr(session.session_id, stats.avg_hr, stats.max_hr);
            updated += 1;
          } else {
            skipped += 1;
          }
        } else {
          skipped += 1;
        }
      } catch (err) {
        errors.push({ sessionId: session.session_id, message: err.message });
      }
      onProgress?.(completed, total);
    }

    return { success: errors.length === 0, updated, skipped, errors };
  },
};

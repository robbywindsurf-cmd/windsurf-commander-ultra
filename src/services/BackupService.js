// BackupService.js — full local database backup/restore, as a real
// safety net independent of anything else (same-bundle-ID app updates
// are already safe — see App.js/db.js — this covers the cases that
// aren't: human error, a future bug, deleting the app by mistake).
//
// Backs up the whole SQLite file directly (expo-sqlite stores it at
// <documentDirectory>SQLite/commander.db) rather than serializing tables
// to JSON — simpler, always 100% complete (every table, index, and any
// future schema addition automatically included with no code changes
// needed here), and restore is just "put the file back".
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';

const DB_PATH = `${FileSystem.documentDirectory}SQLite/commander.db`;
const SQLITE_MAGIC = 'SQLite format 3';

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export const BackupService = {
  // Copies the live database to a timestamped file and opens the native
  // share sheet (AirDrop, Save to Files, etc.) — same pattern
  // PeakMomentScreen.js already uses for sharing a card image.
  async exportBackup() {
    const info = await FileSystem.getInfoAsync(DB_PATH);
    if (!info.exists) throw new Error('No local database found to back up.');

    const backupPath = `${FileSystem.cacheDirectory}commander_backup_${timestampForFilename()}.db`;
    await FileSystem.copyAsync({ from: DB_PATH, to: backupPath });

    if (!(await Sharing.isAvailableAsync())) {
      throw new Error('Sharing is not available on this device.');
    }
    await Sharing.shareAsync(backupPath, { mimeType: 'application/x-sqlite3' });
    return backupPath;
  },

  // Returns the picked asset, or null if cancelled. Doesn't restore yet —
  // callers should confirm with the user before calling restoreBackup(),
  // since it's destructive (overwrites everything currently in the app).
  async pickBackupFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return null;
    return result.assets[0];
  },

  // Overwrites the live database file with the picked backup. A basic
  // magic-bytes check catches an obviously-wrong file (e.g. picking a
  // random photo by mistake) before anything gets overwritten — it can't
  // verify the backup is otherwise *sane*, just that it's really a SQLite
  // file at all. The app must be force-quit and reopened after this —
  // expo-sqlite's connection (and everything cached on top of it
  // elsewhere in the app) is already live in memory and won't pick up a
  // swapped-out file underneath itself.
  async restoreBackup(asset) {
    // Best-effort sanity check, not a hard gate — if partial reads
    // (position/length) aren't actually supported by this API surface,
    // this silently skips rather than incorrectly blocking a genuine
    // backup file. It only ever throws when the check actually ran AND
    // clearly found the wrong kind of file (e.g. a photo picked by
    // mistake), never on an ambiguous read failure.
    try {
      const header = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
        length: SQLITE_MAGIC.length,
        position: 0,
      });
      if (header && !header.startsWith(SQLITE_MAGIC)) {
        throw new Error('That doesn\'t look like a valid database backup file.');
      }
    } catch (err) {
      if (err.message?.includes('valid database backup')) throw err;
      // Any other failure (unsupported options, read error, etc.) — skip
      // the check rather than block the restore over it.
    }

    await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}SQLite`, { intermediates: true }).catch(() => {});
    // copyAsync doesn't overwrite an existing destination — delete first.
    await FileSystem.deleteAsync(DB_PATH, { idempotent: true });
    await FileSystem.copyAsync({ from: asset.uri, to: DB_PATH });
  },
};

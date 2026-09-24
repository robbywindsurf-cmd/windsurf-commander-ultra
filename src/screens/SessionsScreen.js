import React, { useCallback, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, StyleSheet, Modal, View, ActivityIndicator, TextInput } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SessionRepository, EquipmentRepository, TrackpointRepository, SummaryService } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import SessionMapPreview from '../components/SessionMapPreview';
import { pickFitFile, importFitFile, pickFitFiles } from '../services/FITImporter';
import { pickSessionsCsv, importSessionsCsv } from '../services/SessionCsvImporter';
import { colors } from '../theme';

// Some imported CSV history has the literal string "Unknown" in the brand
// column rather than leaving it blank — treat that the same as no brand
// rather than showing "Unknown Cosmic 7.5" in the picker.
function realBrand(brand) {
  return brand && brand.trim().toLowerCase() !== 'unknown' ? brand : null;
}

function formatDistanceKm(distanceM) {
  return distanceM ? `${(distanceM / 1000).toFixed(1)} km` : null;
}

function formatDurationMin(durationS) {
  return durationS ? `${Math.round(durationS / 60)} min` : null;
}

// Only the most recent sessions get a map preview — with real historical
// data, loading (even sampled) trackpoints for every session at once was
// what crashed this screen. Everything older is summary-only.
const MAP_PREVIEW_COUNT = 3;

export default function SessionsScreen({ navigation }) {
  const [sessions, setSessions] = useState([]);
  const [gearCombos, setGearCombos] = useState({});
  const [trackpointsBySession, setTrackpointsBySession] = useState({});
  const [importing, setImporting] = useState(null); // { status, pct } | null
  const [importResult, setImportResult] = useState(null); // { duplicate, session } | null
  const [importError, setImportError] = useState(null);
  const [gearPromptSessionId, setGearPromptSessionId] = useState(null);
  const [equipment, setEquipment] = useState([]);
  const [customMode, setCustomMode] = useState(false);
  const [customBoardId, setCustomBoardId] = useState(null);
  const [customSailId, setCustomSailId] = useState(null);
  const [customFinId, setCustomFinId] = useState(null);
  const [addingType, setAddingType] = useState(null); // 'board' | 'sail' | 'fin' | null
  const [newItemName, setNewItemName] = useState('');
  const [newItemBrand, setNewItemBrand] = useState('');
  const [newItemSize, setNewItemSize] = useState('');

  const load = useCallback(async () => {
    try {
      // Legacy/course/distance repairs moved to App.js's one-time startup
      // pass — they were being re-run here on every load() (every screen
      // focus, every gear assignment, every import), including a full
      // ~950k-row trackpoints scan with no index on `course`, which is
      // what made even a simple gear assignment feel like it hung for
      // ~20 seconds.
      const [all, combos, allEquipment] = await Promise.all([
        SessionRepository.getAll(),
        EquipmentRepository.getGearCombos(),
        // includeInactive to match GarageScreen's own listing — without it
        // this picker silently dropped any gear GarageScreen shows as
        // inactive, so the two screens' lists never agreed.
        EquipmentRepository.getAll(null, { includeInactive: true }),
      ]);
      setSessions(all);
      setGearCombos(Object.fromEntries(combos.map((c) => [c.id, c])));
      setEquipment(allEquipment);

      const recent = all.slice(0, MAP_PREVIEW_COUNT);
      const tpEntries = await Promise.all(
        recent.map(async (s) => [s.session_id, await TrackpointRepository.getSampledForSession(s.session_id, 80)])
      );
      setTrackpointsBySession(Object.fromEntries(tpEntries));
    } catch (err) {
      console.warn('[Sessions] load error:', err.message);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleImportFit() {
    setImportError(null);
    setImportResult(null);
    try {
      const asset = await pickFitFile();
      if (!asset) return;

      setImporting({ status: 'Starting…', pct: 0 });
      const result = await importFitFile(asset, {
        onProgress: (status, pct) => setImporting({ status, pct }),
      });

      setImporting(null);
      setImportResult(result);
      if (!result.duplicate) SummaryService.refreshSummaries().catch((err) => console.warn('[Sessions] summary refresh failed:', err.message));
      await load();
      if (!result.duplicate) setGearPromptSessionId(result.sessionId);
    } catch (err) {
      setImporting(null);
      setImportError(err.message || 'Import failed.');
    }
  }

  // Batch import — no per-file gear prompt (would mean a popup per file,
  // unworkable for a folder of dozens of FIT files); imported sessions
  // land gear-less and get tagged afterward via the "No gear set · tap
  // to add" affordance on each session card. One bad file doesn't abort
  // the rest — errors are collected and shown in the summary instead.
  async function handleImportFitBatch() {
    setImportError(null);
    setImportResult(null);
    try {
      const assets = await pickFitFiles();
      if (!assets) return;

      let imported = 0;
      let duplicates = 0;
      const errors = [];

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        setImporting({ status: `${asset.name} (${i + 1}/${assets.length})`, pct: i / assets.length });
        try {
          const result = await importFitFile(asset, {
            onProgress: (status, pct) => setImporting({ status: `${asset.name} — ${status}`, pct: (i + pct) / assets.length }),
          });
          if (result.duplicate) duplicates += 1; else imported += 1;
        } catch (err) {
          errors.push({ file: asset.name, message: err.message });
        }
      }

      setImporting(null);
      setImportResult({ duplicate: false, batch: { total: assets.length, imported, duplicates, errors } });
      if (imported > 0) SummaryService.refreshSummaries().catch((err) => console.warn('[Sessions] summary refresh failed:', err.message));
      await load();
    } catch (err) {
      setImporting(null);
      setImportError(err.message || 'Import failed.');
    }
  }

  async function handleImportSessionsCsv() {
    setImportError(null);
    setImportResult(null);
    try {
      const asset = await pickSessionsCsv();
      if (!asset) return;

      setImporting({ status: 'Starting…', pct: 0 });
      const result = await importSessionsCsv(asset, {
        onProgress: (status, pct) => setImporting({ status, pct }),
      });

      setImporting(null);
      setImportResult({ duplicate: false, sessionsCsv: result });
      SummaryService.refreshSummaries().catch((err) => console.warn('[Sessions] summary refresh failed:', err.message));
      await load();
    } catch (err) {
      setImporting(null);
      setImportError(err.message || 'Import failed.');
    }
  }

  function closeGearPrompt() {
    setGearPromptSessionId(null);
    setCustomMode(false);
    setCustomBoardId(null);
    setCustomSailId(null);
    setCustomFinId(null);
    setAddingType(null);
    setNewItemName('');
    setNewItemBrand('');
    setNewItemSize('');
  }

  function startAddingItem(type) {
    setAddingType(type);
    setNewItemName('');
    setNewItemBrand('');
    setNewItemSize('');
  }

  // Lets you add a piece of gear you don't already own an equipment row
  // for, right from the gear-assignment prompt, instead of having to back
  // out to the Garage tab first.
  async function saveNewItem() {
    if (!newItemName.trim()) return;
    const result = await EquipmentRepository.insert({
      type: addingType,
      name: newItemName.trim(),
      brand: newItemBrand.trim() || null,
      size: newItemSize.trim() || null,
    });
    const id = result.lastInsertRowId;
    const item = { id, type: addingType, name: newItemName.trim(), brand: newItemBrand.trim() || null, size: newItemSize.trim() || null };
    setEquipment((prev) => [...prev, item]);
    if (addingType === 'board') setCustomBoardId(id);
    else if (addingType === 'sail') setCustomSailId(id);
    else setCustomFinId(id);
    setAddingType(null);
  }

  async function assignGear(comboId) {
    if (gearPromptSessionId) {
      await SessionRepository.setGearCombo(gearPromptSessionId, comboId);
      await load();
    }
    closeGearPrompt();
  }

  // Builds (or reuses) a combo from individually-picked board/sail/fin —
  // the combo picker only offers whole existing combos, which on a garage
  // with many near-duplicate entries (imported "Fox / Addict" logged
  // under several different fins) makes finding "my actual gear today"
  // more a search problem than a pick-from-list one. Reuses an existing
  // combo with the exact same board/sail/fin rather than always creating
  // a new one.
  async function assignCustomGear() {
    if (!gearPromptSessionId || !customBoardId) return;
    try {
      const existing = Object.values(gearCombos).find((c) =>
        (c.board_id || null) === (customBoardId || null) &&
        (c.sail_id || null) === (customSailId || null) &&
        (c.fin_id || null) === (customFinId || null)
      );
      let comboId = existing?.id;
      if (!comboId) {
        const board = equipment.find((e) => e.id === customBoardId);
        const sail = customSailId ? equipment.find((e) => e.id === customSailId) : null;
        const name = [board?.name, sail?.name].filter(Boolean).join(' / ') || board?.name;
        const result = await EquipmentRepository.insertGearCombo({
          name, board_id: customBoardId, sail_id: customSailId, fin_id: customFinId,
        });
        comboId = result.lastInsertRowId;
      }
      await SessionRepository.setGearCombo(gearPromptSessionId, comboId);
      await load();
      closeGearPrompt();
    } catch (err) {
      console.log('[SessionsScreen] assignCustomGear FAILED', err.message, err.stack);
    }
  }

  // Excludes combos auto-created just to link a noisy historical CSV row
  // (misspelled/lowercase/"Unknown" sail names etc.) to a session's
  // gear_combo_id — the picker should only ever offer gear you actually
  // curated (combos.csv, Garage, or this screen's own custom builder).
  const curatedCombos = Object.values(gearCombos).filter((c) => (c.source || 'manual') === 'manual');

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={`${sessions.length} sessions`} title="📅 Sessions" />

      <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={handleImportFit}>
        <Text style={styles.importBtnText}>📥 Import FIT File</Text>
        <Text style={styles.importBtnSub}>GPS + trackpoints</Text>
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.7} style={styles.importHistoricalBtn} onPress={handleImportFitBatch}>
        <Text style={styles.importHistoricalBtnText}>📥 Import Multiple FIT Files</Text>
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.7} style={styles.importBtn} onPress={handleImportSessionsCsv}>
        <Text style={styles.importBtnText}>📄 Import Sessions CSV</Text>
        <Text style={styles.importBtnSub}>Session history + gear</Text>
      </TouchableOpacity>

      <TouchableOpacity activeOpacity={0.7}
        style={styles.importHistoricalBtn}
        onPress={() => navigation.navigate('ImportData')}
        accessibilityLabel="Import historical data"
      >
        <Text style={styles.importHistoricalBtnText}>🗄️ Import historical data (weather, combos)</Text>
      </TouchableOpacity>

      {!!importError && <Text style={styles.errorText}>⚠️ {importError}</Text>}

      {importResult?.sessionsCsv && (
        <SharedCard>
          <Text style={styles.resultTitle}>✅ Sessions CSV imported</Text>
          <Text style={styles.resultText}>
            {importResult.sessionsCsv.total} rows · {importResult.sessionsCsv.updated} updated · {importResult.sessionsCsv.created} new
          </Text>
        </SharedCard>
      )}

      {importResult?.batch && (
        <SharedCard>
          <Text style={styles.resultTitle}>
            {importResult.batch.errors.length ? '⚠️' : '✅'} {importResult.batch.imported} imported, {importResult.batch.duplicates} already had this session
          </Text>
          {importResult.batch.imported > 0 && (
            <Text style={styles.resultText}>Tap "No gear set · tap to add" on each new session below to assign gear.</Text>
          )}
          {importResult.batch.errors.map((e) => (
            <Text key={e.file} style={styles.errorText}>⚠️ {e.file}: {e.message}</Text>
          ))}
        </SharedCard>
      )}

      {importResult && !importResult.sessionsCsv && !importResult.batch && (
        <SharedCard>
          {importResult.duplicate ? (
            <Text style={styles.resultText}>⚠️ This session is already imported.</Text>
          ) : (
            <>
              <Text style={styles.resultTitle}>✅ Session imported</Text>
              <Text style={styles.resultText}>
                {importResult.session.date} · {importResult.session.durationMinutes ?? '—'} min
              </Text>
              <Text style={styles.resultText}>
                {importResult.session.trackpoints.toLocaleString()} trackpoints · Peak {importResult.session.maxSpeedKn ?? '—'} kn
                {importResult.session.distanceKm != null ? ` · ${importResult.session.distanceKm} km` : ''}
              </Text>
            </>
          )}
        </SharedCard>
      )}

      {sessions.length === 0 ? (
        <Text style={styles.emptyText}>No sessions yet. Import a FIT file to get started.</Text>
      ) : (
        sessions.map((s, i) => {
          const gear = gearCombos[s.gear_combo_id];
          const stats = [
            s.max_speed_kn != null ? `${s.max_speed_kn.toFixed(1)} kn max` : 'No speed data',
            formatDistanceKm(s.distance_m),
            formatDurationMin(s.duration_s),
          ].filter(Boolean).join(' · ');

          const goToDetail = () => navigation.navigate('SessionDetail', { sessionId: s.session_id });
          const showMap = i < MAP_PREVIEW_COUNT;

          return (
            <TouchableOpacity activeOpacity={0.7} key={s.session_id} onPress={goToDetail}>
              <SharedCard>
                <Text style={styles.title}>{s.date} {s.start_time ? `· ${s.start_time}` : ''}</Text>
                <Text style={styles.meta}>{stats}</Text>
                {gear ? (
                  <TouchableOpacity activeOpacity={0.7} onPress={() => setGearPromptSessionId(s.session_id)}>
                    <Text style={styles.gear}>
                      🏄 {[gear.board_name, gear.sail_name && `${gear.sail_name}${gear.sail_size ? ` ${gear.sail_size}m` : ''}`, gear.fin_name]
                        .filter(Boolean).join(' · ')} · change
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity activeOpacity={0.7} onPress={() => setGearPromptSessionId(s.session_id)}>
                    <Text style={styles.gearMissing}>🏄 No gear set · tap to add</Text>
                  </TouchableOpacity>
                )}
                {showMap && <SessionMapPreview trackpoints={trackpointsBySession[s.session_id]} onPress={goToDetail} />}
              </SharedCard>
            </TouchableOpacity>
          );
        })
      )}

      <Modal statusBarTranslucent visible={!!gearPromptSessionId} animationType="slide" transparent onRequestClose={closeGearPrompt}>
        <View style={styles.modalOverlay}>
          <View style={styles.gearPromptBox}>
            <Text style={styles.modalTitle}>Which gear did you use?</Text>

            <View style={styles.gearModeRow}>
              <TouchableOpacity activeOpacity={0.7}
                style={[styles.gearModeBtn, !customMode && styles.gearModeBtnActive]}
                onPress={() => setCustomMode(false)}
              >
                <Text style={styles.gearModeBtnText}>Existing combo</Text>
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.7}
                style={[styles.gearModeBtn, customMode && styles.gearModeBtnActive]}
                onPress={() => setCustomMode(true)}
              >
                <Text style={styles.gearModeBtnText}>🔧 Build custom</Text>
              </TouchableOpacity>
            </View>

            {customMode ? (
              <>
                {['board', 'sail', 'fin'].map((type) => (
                  <View key={type}>
                    <Text style={styles.gearPickerLabel}>{type === 'fin' ? 'Fin (optional)' : type[0].toUpperCase() + type.slice(1)}</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.gearChipRow}>
                      {equipment.filter((e) => e.type === type).map((e) => {
                        const selectedId = type === 'board' ? customBoardId : type === 'sail' ? customSailId : customFinId;
                        const setSelected = type === 'board' ? setCustomBoardId : type === 'sail' ? setCustomSailId : setCustomFinId;
                        const selected = selectedId === e.id;
                        return (
                          <TouchableOpacity activeOpacity={0.7} key={e.id}
                            style={[styles.gearChip, selected && styles.gearChipSelected]}
                            onPress={() => setSelected(selected ? null : e.id)}
                          >
                            <Text style={[styles.gearChipText, selected && styles.gearChipTextSelected]}>
                              {realBrand(e.brand) ? `${realBrand(e.brand)} ` : ''}{e.name}{e.size ? ` ${e.size}` : ''}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                      <TouchableOpacity activeOpacity={0.7}
                        style={[styles.gearChip, styles.gearChipAdd]}
                        onPress={() => startAddingItem(type)}
                      >
                        <Text style={styles.gearChipAddText}>+ Add new</Text>
                      </TouchableOpacity>
                    </ScrollView>
                    {addingType === type && (
                      <View style={styles.addItemBox}>
                        <TextInput
                          style={styles.addItemInput}
                          placeholder="Name (required)"
                          placeholderTextColor="rgba(205,232,240,0.35)"
                          value={newItemName}
                          onChangeText={setNewItemName}
                        />
                        <View style={styles.addItemRow}>
                          <TextInput
                            style={[styles.addItemInput, styles.addItemInputHalf]}
                            placeholder="Brand"
                            placeholderTextColor="rgba(205,232,240,0.35)"
                            value={newItemBrand}
                            onChangeText={setNewItemBrand}
                          />
                          <TextInput
                            style={[styles.addItemInput, styles.addItemInputHalf]}
                            placeholder="Size"
                            placeholderTextColor="rgba(205,232,240,0.35)"
                            value={newItemSize}
                            onChangeText={setNewItemSize}
                          />
                        </View>
                        <View style={styles.addItemRow}>
                          <TouchableOpacity activeOpacity={0.7} style={styles.addItemCancelBtn} onPress={() => setAddingType(null)}>
                            <Text style={styles.addItemCancelBtnText}>Cancel</Text>
                          </TouchableOpacity>
                          <TouchableOpacity activeOpacity={0.7}
                            style={[styles.addItemSaveBtn, !newItemName.trim() && styles.assignCustomBtnDisabled]}
                            disabled={!newItemName.trim()}
                            onPress={saveNewItem}
                          >
                            <Text style={styles.addItemSaveBtnText}>Save</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>
                ))}
                <TouchableOpacity activeOpacity={0.7}
                  style={[styles.assignCustomBtn, !customBoardId && styles.assignCustomBtnDisabled]}
                  disabled={!customBoardId}
                  onPress={assignCustomGear}
                >
                  <Text style={styles.assignCustomBtnText}>Assign this combo</Text>
                </TouchableOpacity>
              </>
            ) : curatedCombos.length === 0 ? (
              <Text style={styles.resultText}>No gear combos yet — add one in the Garage tab, or build a custom one above.</Text>
            ) : (
              <ScrollView style={styles.gearComboScroll}>
                {curatedCombos.map((c) => (
                  <TouchableOpacity activeOpacity={0.7} key={c.id} style={styles.gearOption} onPress={() => assignGear(c.id)}>
                    <Text style={styles.gearOptionName}>{c.name}</Text>
                    <Text style={styles.gearOptionMeta}>
                      {[c.board_name, c.sail_name].filter(Boolean).join(' + ')}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            <TouchableOpacity activeOpacity={0.7} style={styles.skipBtn} onPress={closeGearPrompt}>
              <Text style={styles.skipBtnText}>Skip</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={!!importing} animationType="fade" transparent statusBarTranslucent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <ActivityIndicator color={colors.accent} size="large" style={{ marginBottom: 12 }} />
            <Text style={styles.modalStatus}>{importing?.status}</Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round((importing?.pct || 0) * 100)}%` }]} />
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  title: { color: colors.text, fontWeight: '600', fontSize: 14, marginBottom: 4 },
  meta: { color: 'rgba(205,232,240,0.5)', fontSize: 12 },
  gear: { color: colors.accent, fontSize: 11, marginTop: 6 },
  gearMissing: { color: 'rgba(205,232,240,0.4)', fontSize: 11, marginTop: 6, fontStyle: 'italic' },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },

  importBtn: {
    backgroundColor: colors.accent, paddingVertical: 12, borderRadius: 12,
    alignItems: 'center', marginBottom: 12,
  },
  importBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  importBtnSub: { color: 'rgba(255,255,255,0.75)', fontSize: 11, marginTop: 2 },
  importHistoricalBtn: {
    backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
    paddingVertical: 10, borderRadius: 12, alignItems: 'center', marginBottom: 12,
  },
  importHistoricalBtnText: { color: colors.text, fontWeight: '600', fontSize: 13 },
  errorText: { color: colors.danger, fontSize: 12, textAlign: 'center', marginBottom: 10 },
  resultTitle: { color: colors.text, fontWeight: '700', fontSize: 14, marginBottom: 4 },
  resultText: { color: 'rgba(205,232,240,0.7)', fontSize: 12, marginBottom: 2 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  gearPromptBox: {
    width: '85%', maxHeight: '80%', backgroundColor: colors.deep, borderRadius: 14, padding: 20,
    borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  gearComboScroll: { maxHeight: 380 },
  gearOption: {
    backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  gearOptionName: { color: colors.text, fontWeight: '700', fontSize: 14 },
  gearOptionMeta: { color: 'rgba(205,232,240,0.5)', fontSize: 12, marginTop: 2 },
  skipBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 4 },
  skipBtnText: { color: 'rgba(205,232,240,0.5)', fontSize: 13, fontWeight: '600' },
  gearModeRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  gearModeBtn: {
    flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  gearModeBtnActive: { backgroundColor: 'rgba(26,138,181,0.25)', borderColor: colors.accent },
  gearModeBtnText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  gearPickerLabel: { color: 'rgba(205,232,240,0.6)', fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6, marginTop: 10 },
  gearChipRow: { flexDirection: 'row' },
  gearChip: {
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, marginRight: 8,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  gearChipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  gearChipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  gearChipTextSelected: { color: '#fff' },
  gearChipAdd: { backgroundColor: 'transparent', borderStyle: 'dashed', borderColor: 'rgba(26,138,181,0.5)' },
  gearChipAddText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  addItemBox: {
    backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 10, marginTop: 8,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  addItemInput: {
    backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
    color: colors.text, fontSize: 13, marginBottom: 8,
  },
  addItemRow: { flexDirection: 'row', gap: 8 },
  addItemInputHalf: { flex: 1 },
  addItemCancelBtn: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.06)' },
  addItemCancelBtnText: { color: 'rgba(205,232,240,0.6)', fontSize: 12, fontWeight: '600' },
  addItemSaveBtn: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', backgroundColor: colors.accent },
  addItemSaveBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  assignCustomBtn: {
    backgroundColor: colors.accent, paddingVertical: 12, borderRadius: 10, alignItems: 'center', marginTop: 16,
  },
  assignCustomBtnDisabled: { opacity: 0.4 },
  assignCustomBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  modalBox: {
    width: '80%', backgroundColor: colors.deep, borderRadius: 14, padding: 20,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  modalStatus: { color: colors.text, fontSize: 13, textAlign: 'center', marginBottom: 12 },
  progressTrack: {
    width: '100%', height: 8, backgroundColor: 'rgba(26,138,181,0.2)',
    borderRadius: 4, overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 4 },
});

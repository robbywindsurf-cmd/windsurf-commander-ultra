import React, { useCallback, useState } from 'react';
import {
  ScrollView, Text, View, TextInput, TouchableOpacity, StyleSheet, Modal, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { EquipmentRepository } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import SwipeableRow from '../components/SwipeableRow';
import { colors } from '../theme';

const TYPES = [
  { key: 'board', label: 'Boards', emoji: '🏄' },
  { key: 'sail', label: 'Sails', emoji: '🪁' },
  { key: 'fin', label: 'Fins', emoji: '🔩' },
];

const FIN_TYPES = ['slalom', 'wave', 'freeride'];

const EMPTY_FORM = {
  id: null, type: 'board', name: '', brand: '', year: '', notes: '',
  size: '', volume_l: '', width_cm: '', mast_length_cm: '', boom_length_cm: '', fin_type: '',
};

function metaLine(item) {
  if (item.type === 'board') {
    return [item.brand, item.volume_l ? `${item.volume_l}L` : null, item.width_cm ? `${item.width_cm}cm wide` : null, item.year]
      .filter(Boolean).join(' · ') || '—';
  }
  if (item.type === 'sail') {
    return [item.brand, item.size ? `${item.size}m²` : null, item.mast_length_cm ? `mast ${item.mast_length_cm}cm` : null, item.boom_length_cm ? `boom ${item.boom_length_cm}cm` : null, item.year]
      .filter(Boolean).join(' · ') || '—';
  }
  if (item.type === 'fin') {
    return [item.brand, item.size ? `${item.size}cm` : null, item.fin_type, item.year]
      .filter(Boolean).join(' · ') || '—';
  }
  return [item.brand, item.size, item.year].filter(Boolean).join(' · ') || '—';
}

export default function GarageScreen() {
  const [equipment, setEquipment] = useState([]);
  const [combos, setCombos] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formVisible, setFormVisible] = useState(false);

  const [comboVisible, setComboVisible] = useState(false);
  const [comboName, setComboName] = useState('');
  const [comboBoardId, setComboBoardId] = useState(null);
  const [comboSailId, setComboSailId] = useState(null);
  const [comboFinId, setComboFinId] = useState(null);

  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    try {
      const [all, combosList] = await Promise.all([
        EquipmentRepository.getAll(null, { includeInactive: true }),
        EquipmentRepository.getGearCombos(),
      ]);
      setEquipment(all);
      setCombos(combosList);
    } catch (err) {
      console.warn('[Garage] load error:', err.message);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  function openAddForm(type) {
    setForm({ ...EMPTY_FORM, type });
    setFormVisible(true);
  }

  function openEditForm(item) {
    setForm({
      id: item.id, type: item.type,
      name: item.name || '', brand: item.brand || '', year: item.year ? String(item.year) : '',
      notes: item.notes || '', size: item.size || '',
      volume_l: item.volume_l ? String(item.volume_l) : '',
      width_cm: item.width_cm ? String(item.width_cm) : '',
      mast_length_cm: item.mast_length_cm ? String(item.mast_length_cm) : '',
      boom_length_cm: item.boom_length_cm ? String(item.boom_length_cm) : '',
      fin_type: item.fin_type || '',
    });
    setFormVisible(true);
  }

  async function saveForm() {
    if (!form.name.trim()) return;
    const num = (v) => (v.trim() ? parseFloat(v) : null);
    const payload = {
      type: form.type,
      name: form.name.trim(),
      brand: form.brand.trim() || null,
      year: form.year.trim() ? parseInt(form.year, 10) : null,
      notes: form.notes.trim() || null,
      size: form.type === 'sail' || form.type === 'fin' ? (form.size.trim() || null) : null,
      volume_l: form.type === 'board' ? num(form.volume_l) : null,
      width_cm: form.type === 'board' ? num(form.width_cm) : null,
      mast_length_cm: form.type === 'sail' ? num(form.mast_length_cm) : null,
      boom_length_cm: form.type === 'sail' ? num(form.boom_length_cm) : null,
      fin_type: form.type === 'fin' ? (form.fin_type || null) : null,
    };

    if (form.id) {
      await EquipmentRepository.update(form.id, payload);
    } else {
      await EquipmentRepository.insert(payload);
    }
    setFormVisible(false);
    load();
  }

  async function deleteEquipment(id) {
    await EquipmentRepository.deactivate(id);
    load();
  }

  function openComboForm() {
    setComboName('');
    setComboBoardId(null);
    setComboSailId(null);
    setComboFinId(null);
    setComboVisible(true);
  }

  async function saveCombo() {
    if (!comboName.trim() || !comboBoardId || !comboSailId) {
      Alert.alert('Missing info', 'Give the combo a name and pick at least a board and sail.');
      return;
    }
    await EquipmentRepository.insertGearCombo({
      name: comboName.trim(),
      board_id: comboBoardId,
      sail_id: comboSailId,
      fin_id: comboFinId,
      notes: null,
    });
    setComboVisible(false);
    load();
  }

  async function deleteCombo(id) {
    await EquipmentRepository.deleteGearCombo(id);
    load();
  }

  const byType = (type) => equipment
    .filter((e) => e.type === type)
    .filter((e) => showInactive || e.active === 1);

  const inactiveCount = equipment.filter((e) => e.active !== 1).length;

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={`${equipment.filter((e) => e.active === 1).length} active · ${combos.length} combos`} title="⚙️ Garage" />

      {inactiveCount > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.inactiveToggle} onPress={() => setShowInactive((v) => !v)}>
          <Text style={styles.inactiveToggleText}>
            {showInactive ? '👁️ Showing inactive gear' : `👁️‍🗨️ Show ${inactiveCount} inactive item${inactiveCount > 1 ? 's' : ''}`}
          </Text>
        </TouchableOpacity>
      )}

      {TYPES.map(({ key, label, emoji }) => (
        <View key={key}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>{emoji} {label}</Text>
            <TouchableOpacity activeOpacity={0.7} style={styles.addBtn} onPress={() => openAddForm(key)}>
              <Text style={styles.addBtnText}>+ Add</Text>
            </TouchableOpacity>
          </View>

          {byType(key).length === 0 ? (
            <Text style={styles.emptyText}>None added yet.</Text>
          ) : (
            byType(key).map((item) => (
              <SwipeableRow key={item.id} onDelete={() => deleteEquipment(item.id)} confirmMessage={`Remove ${item.name}?`}>
                <TouchableOpacity activeOpacity={0.7} onPress={() => openEditForm(item)} style={[styles.card, item.active !== 1 && styles.cardInactive]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardName}>
                      {item.name}{item.active !== 1 ? '  ' : ''}
                      {item.active !== 1 && <Text style={styles.inactiveBadge}>INACTIVE</Text>}
                    </Text>
                    <Text style={styles.cardMeta}>{metaLine(item)}</Text>
                  </View>
                  <Text style={styles.editIcon}>✏️</Text>
                  <TouchableOpacity activeOpacity={0.7} onPress={() => Alert.alert('Delete?', `Remove ${item.name}?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => deleteEquipment(item.id) },
                  ])}>
                    <Text style={styles.deleteX}>✕</Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              </SwipeableRow>
            ))
          )}
        </View>
      ))}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>🎯 Gear Combinations</Text>
        <TouchableOpacity activeOpacity={0.7} style={styles.addBtn} onPress={openComboForm}>
          <Text style={styles.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {combos.length === 0 ? (
        <Text style={styles.emptyText}>No combos yet — add a board and sail first.</Text>
      ) : (
        combos.map((c) => (
          <SwipeableRow key={c.id} onDelete={() => deleteCombo(c.id)} confirmMessage={`Remove combo "${c.name}"?`}>
            <View style={styles.card}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{c.name}</Text>
                <Text style={styles.cardMeta}>
                  {[c.board_name, c.sail_name && `${c.sail_name}${c.sail_size ? ` ${c.sail_size}m²` : ''}`, c.fin_name]
                    .filter(Boolean).join(' + ')}
                </Text>
                <Text style={styles.comboRange}>
                  {c.category ? `${c.category} · ` : ''}
                  {c.wind_min_kn != null ? `💨 ${c.wind_min_kn}-${c.wind_max_kn}kn` : ''}
                  {c.wave_min_m != null ? ` · 🌊 ${c.wave_min_m}-${c.wave_max_m}m` : ''}
                </Text>
                {!!c.notes && <Text style={styles.comboNotes}>{c.notes}</Text>}
              </View>
            </View>
          </SwipeableRow>
        ))
      )}

      {/* Add/Edit equipment modal */}
      <Modal statusBarTranslucent visible={formVisible} animationType="slide" transparent onRequestClose={() => setFormVisible(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{form.id ? 'Edit' : 'Add'} {form.type}</Text>

            <TextInput autoCorrect={false} style={styles.input} placeholder="Name" placeholderTextColor="rgba(205,232,240,0.4)" value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} />
            <TextInput autoCorrect={false} style={styles.input} placeholder="Brand" placeholderTextColor="rgba(205,232,240,0.4)" value={form.brand} onChangeText={(v) => setForm({ ...form, brand: v })} />

            {form.type === 'board' && (
              <>
                <TextInput style={styles.input} placeholder="Volume (litres)" placeholderTextColor="rgba(205,232,240,0.4)" keyboardType="numeric" value={form.volume_l} onChangeText={(v) => setForm({ ...form, volume_l: v })} />
                <TextInput style={styles.input} placeholder="Width (cm)" placeholderTextColor="rgba(205,232,240,0.4)" keyboardType="numeric" value={form.width_cm} onChangeText={(v) => setForm({ ...form, width_cm: v })} />
              </>
            )}

            {form.type === 'sail' && (
              <>
                <TextInput style={styles.input} placeholder="Size (m²)" placeholderTextColor="rgba(205,232,240,0.4)" keyboardType="numeric" value={form.size} onChangeText={(v) => setForm({ ...form, size: v })} />
                <TextInput style={styles.input} placeholder="Mast length (cm)" placeholderTextColor="rgba(205,232,240,0.4)" keyboardType="numeric" value={form.mast_length_cm} onChangeText={(v) => setForm({ ...form, mast_length_cm: v })} />
                <TextInput style={styles.input} placeholder="Boom length (cm)" placeholderTextColor="rgba(205,232,240,0.4)" keyboardType="numeric" value={form.boom_length_cm} onChangeText={(v) => setForm({ ...form, boom_length_cm: v })} />
              </>
            )}

            {form.type === 'fin' && (
              <>
                <TextInput style={styles.input} placeholder="Size (cm)" placeholderTextColor="rgba(205,232,240,0.4)" keyboardType="numeric" value={form.size} onChangeText={(v) => setForm({ ...form, size: v })} />
                <View style={styles.chipRow}>
                  {FIN_TYPES.map((t) => (
                    <TouchableOpacity activeOpacity={0.7} key={t} style={[styles.chip, form.fin_type === t && styles.chipActive]} onPress={() => setForm({ ...form, fin_type: t })}>
                      <Text style={[styles.chipText, form.fin_type === t && styles.chipTextActive]}>{t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            <TextInput style={styles.input} placeholder="Year" placeholderTextColor="rgba(205,232,240,0.4)" keyboardType="numeric" value={form.year} onChangeText={(v) => setForm({ ...form, year: v })} />
            <TextInput style={styles.input} placeholder="Notes" placeholderTextColor="rgba(205,232,240,0.4)" value={form.notes} onChangeText={(v) => setForm({ ...form, notes: v })} />

            <View style={styles.modalBtnRow}>
              <TouchableOpacity activeOpacity={0.7} style={styles.cancelBtn} onPress={() => setFormVisible(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.7} style={styles.saveBtn} onPress={saveForm}>
                <Text style={styles.saveBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add gear combo modal */}
      <Modal statusBarTranslucent visible={comboVisible} animationType="slide" transparent onRequestClose={() => setComboVisible(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>New Gear Combo</Text>
            <TextInput style={styles.input} placeholder='e.g. "Light wind setup"' placeholderTextColor="rgba(205,232,240,0.4)" value={comboName} onChangeText={setComboName} />

            <Text style={styles.pickerLabel}>Board</Text>
            <View style={styles.chipRow}>
              {byType('board').map((b) => (
                <TouchableOpacity activeOpacity={0.7} key={b.id} style={[styles.chip, comboBoardId === b.id && styles.chipActive]} onPress={() => setComboBoardId(b.id)}>
                  <Text style={[styles.chipText, comboBoardId === b.id && styles.chipTextActive]}>{b.name}</Text>
                </TouchableOpacity>
              ))}
              {byType('board').length === 0 && <Text style={styles.emptyText}>Add a board first.</Text>}
            </View>

            <Text style={styles.pickerLabel}>Sail</Text>
            <View style={styles.chipRow}>
              {byType('sail').map((s) => (
                <TouchableOpacity activeOpacity={0.7} key={s.id} style={[styles.chip, comboSailId === s.id && styles.chipActive]} onPress={() => setComboSailId(s.id)}>
                  <Text style={[styles.chipText, comboSailId === s.id && styles.chipTextActive]}>{s.name}</Text>
                </TouchableOpacity>
              ))}
              {byType('sail').length === 0 && <Text style={styles.emptyText}>Add a sail first.</Text>}
            </View>

            <Text style={styles.pickerLabel}>Fin (optional)</Text>
            <View style={styles.chipRow}>
              {byType('fin').map((f) => (
                <TouchableOpacity activeOpacity={0.7} key={f.id} style={[styles.chip, comboFinId === f.id && styles.chipActive]} onPress={() => setComboFinId(comboFinId === f.id ? null : f.id)}>
                  <Text style={[styles.chipText, comboFinId === f.id && styles.chipTextActive]}>{f.name}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.modalBtnRow}>
              <TouchableOpacity activeOpacity={0.7} style={styles.cancelBtn} onPress={() => setComboVisible(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.7} style={styles.saveBtn} onPress={saveCombo}>
                <Text style={styles.saveBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },

  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 16, marginBottom: 8,
  },
  sectionLabel: {
    color: 'rgba(205,232,240,0.6)', fontSize: 12, fontWeight: '700',
    letterSpacing: 1.5, textTransform: 'uppercase',
  },
  addBtn: { backgroundColor: colors.accent, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 8 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 12, marginBottom: 4 },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.3)',
    borderRadius: 12, padding: 12,
  },
  cardInactive: { opacity: 0.55, borderColor: 'rgba(205,232,240,0.2)' },
  cardName: { color: colors.text, fontWeight: '700', fontSize: 15 },
  cardMeta: { color: 'rgba(205,232,240,0.5)', fontSize: 12, marginTop: 3 },
  comboRange: { color: colors.accent, fontSize: 11, marginTop: 4, fontWeight: '600' },
  comboNotes: { color: 'rgba(205,232,240,0.5)', fontSize: 11, marginTop: 3, fontStyle: 'italic' },
  inactiveBadge: { color: colors.amber, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  editIcon: { fontSize: 14 },
  deleteX: { color: colors.danger, fontSize: 16, fontWeight: '700', paddingLeft: 4 },

  inactiveToggle: {
    backgroundColor: 'rgba(240,165,0,0.1)', borderWidth: 1, borderColor: 'rgba(240,165,0,0.25)',
    borderRadius: 10, padding: 10, alignItems: 'center', marginBottom: 8,
  },
  inactiveToggleText: { color: colors.amber, fontSize: 12, fontWeight: '600' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalBox: {
    backgroundColor: colors.deep, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 16, maxHeight: '85%', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 10, textTransform: 'capitalize' },
  pickerLabel: { color: 'rgba(205,232,240,0.5)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, marginTop: 4 },

  input: {
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.2)',
    borderRadius: 8, color: colors.text, paddingHorizontal: 10, paddingVertical: 10, marginBottom: 8, fontSize: 14,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)' },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 12, textTransform: 'capitalize' },
  chipTextActive: { color: '#fff', fontWeight: '700' },

  modalBtnRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: 'rgba(230,57,70,0.15)', borderWidth: 1, borderColor: 'rgba(230,57,70,0.3)' },
  cancelBtnText: { color: colors.danger, fontWeight: '700', fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: colors.accent },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { EquipmentRepository } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { colors } from '../theme';

const TYPES = ['board', 'sail', 'fin'];

export default function GarageScreen() {
  const [equipment, setEquipment] = useState([]);
  const [name, setName] = useState('');
  const [type, setType] = useState('board');
  const [brand, setBrand] = useState('');
  const [size, setSize] = useState('');

  const load = useCallback(async () => {
    try {
      const all = await EquipmentRepository.getAll();
      setEquipment(all);
    } catch (err) {
      console.warn('[Garage] load error:', err.message);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function addEquipment() {
    if (!name.trim()) return;
    await EquipmentRepository.insert({ type, name: name.trim(), brand: brand.trim() || null, size: size.trim() || null, year: null, notes: null });
    setName(''); setBrand(''); setSize('');
    load();
  }

  async function removeEquipment(id) {
    await EquipmentRepository.deactivate(id);
    load();
  }

  const grouped = TYPES.map((t) => ({ type: t, items: equipment.filter((e) => e.type === t) }));

  return (
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={`${equipment.length} items`} title="⚙️ Garage" />

      <SharedCard>
        <Text style={styles.formLabel}>Add equipment</Text>
        <View style={styles.typeRow}>
          {TYPES.map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.typeChip, type === t && styles.typeChipActive]}
              onPress={() => setType(t)}
            >
              <Text style={[styles.typeChipText, type === t && styles.typeChipTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput style={styles.input} placeholder="Name" placeholderTextColor="rgba(205,232,240,0.4)" value={name} onChangeText={setName} />
        <TextInput style={styles.input} placeholder="Brand" placeholderTextColor="rgba(205,232,240,0.4)" value={brand} onChangeText={setBrand} />
        <TextInput style={styles.input} placeholder="Size" placeholderTextColor="rgba(205,232,240,0.4)" value={size} onChangeText={setSize} />
        <TouchableOpacity style={styles.addBtn} onPress={addEquipment}>
          <Text style={styles.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </SharedCard>

      {grouped.map(({ type: t, items }) => (
        <View key={t}>
          <Text style={styles.sectionLabel}>{t}s</Text>
          {items.length === 0 ? (
            <Text style={styles.emptyText}>None added yet.</Text>
          ) : (
            items.map((item) => (
              <SharedCard key={item.id} style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemMeta}>
                    {[item.brand, item.size].filter(Boolean).join(' · ') || '—'}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => removeEquipment(item.id)}>
                  <Text style={styles.deleteText}>✕</Text>
                </TouchableOpacity>
              </SharedCard>
            ))
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  sectionLabel: {
    color: 'rgba(205,232,240,0.5)', fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8, marginTop: 16,
  },
  formLabel: { color: colors.text, fontWeight: '700', fontSize: 14, marginBottom: 8 },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  typeChip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)' },
  typeChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  typeChipText: { color: colors.text, fontSize: 12, textTransform: 'capitalize' },
  typeChipTextActive: { color: '#fff', fontWeight: '700' },
  input: {
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.2)',
    borderRadius: 8, color: colors.text, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8, fontSize: 13,
  },
  addBtn: { backgroundColor: colors.accent, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  itemRow: { flexDirection: 'row', alignItems: 'center' },
  itemName: { color: colors.text, fontWeight: '600', fontSize: 14 },
  itemMeta: { color: 'rgba(205,232,240,0.5)', fontSize: 12, marginTop: 2 },
  deleteText: { color: colors.danger, fontSize: 16, fontWeight: '700', paddingLeft: 10 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 12, marginBottom: 8 },
});

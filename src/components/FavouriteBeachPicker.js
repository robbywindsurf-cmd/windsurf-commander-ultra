import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { BeachRepository, UserStore } from '@commandersuite/core';
import { colors } from '../theme';

/**
 * Blocking first-launch picker: every beach-aware feature in the app
 * (Weather header, Peak Moment, session weather/tide lookups, AI briefing)
 * reads the user's favourite beach rather than assuming one, so the app
 * can't do anything location-aware until this is set.
 *
 * Two modes:
 *  - forced (no onClose): full-screen, no dismiss — first launch only.
 *  - "Change" mode (onClose provided): normal dismissable modal from Settings.
 */
export default function FavouriteBeachPicker({ visible, onSelected, onClose }) {
  const [beaches, setBeaches] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, favourite] = await Promise.all([
        BeachRepository.getAll(),
        UserStore.getFavouriteBeach(),
      ]);
      setBeaches(all);
      setCurrentId(favourite?.id ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  async function selectBeach(beach) {
    setSavingId(beach.id);
    try {
      await UserStore.setFavouriteBeach(beach.id);
      setCurrentId(beach.id);
      onSelected?.(beach);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Modal
      statusBarTranslucent
      visible={visible}
      animationType="slide"
      transparent={!!onClose}
      onRequestClose={onClose || (() => {})}
    >
      <View style={onClose ? styles.overlay : styles.fullscreen}>
        <View style={onClose ? styles.sheet : styles.fullscreenInner}>
          <Text style={styles.title}>
            {onClose ? 'Change favourite beach' : 'Choose your favourite beach'}
          </Text>
          {!onClose && (
            <Text style={styles.subtitle}>
              Used for weather, tide and AI briefings by default — you can change it later.
            </Text>
          )}

          {loading ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 30 }} />
          ) : (
            <FlatList
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              data={beaches}
              keyExtractor={(b) => String(b.id)}
              contentContainerStyle={styles.list}
              renderItem={({ item }) => {
                const isCurrent = item.id === currentId;
                return (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[styles.row, isCurrent && styles.rowActive]}
                    onPress={() => selectBeach(item)}
                    disabled={savingId === item.id}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName}>{isCurrent ? '⭐ ' : ''}{item.name}</Text>
                      <Text style={styles.rowLocation}>
                        {item.lat != null && item.lon != null ? `${item.lat.toFixed(3)}, ${item.lon.toFixed(3)}` : 'Location unknown'}
                      </Text>
                    </View>
                    {savingId === item.id && <ActivityIndicator color={colors.accent} size="small" />}
                  </TouchableOpacity>
                );
              }}
            />
          )}

          {onClose && (
            <TouchableOpacity activeOpacity={0.7} style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>Close</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fullscreen: { flex: 1, backgroundColor: colors.deep },
  fullscreenInner: { flex: 1, paddingTop: 60, paddingHorizontal: 16 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.deep, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    maxHeight: '80%', padding: 16, borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
  },
  title: { color: '#fff', fontSize: 18, fontWeight: '800', marginBottom: 6, textAlign: 'center' },
  subtitle: { color: 'rgba(205,232,240,0.5)', fontSize: 13, textAlign: 'center', marginBottom: 20, paddingHorizontal: 10 },
  list: { paddingBottom: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 12, backgroundColor: 'rgba(26,138,181,0.06)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.12)',
    marginBottom: 8,
  },
  rowActive: { borderColor: colors.accent, backgroundColor: 'rgba(26,138,181,0.15)' },
  rowName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  rowLocation: { color: 'rgba(205,232,240,0.4)', fontSize: 11, marginTop: 2 },
  closeBtn: { alignItems: 'center', paddingVertical: 14 },
  closeBtnText: { color: 'rgba(205,232,240,0.5)', fontSize: 14, fontWeight: '600' },
});

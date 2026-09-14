import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, ScrollView } from 'react-native';
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import { TierService, canAccess } from '@commandersuite/core';
import Header from '../components/Header';
import PeakMomentCard from '../components/PeakMomentCard';
import { PeakMomentService } from '../services/PeakMomentService';
import { colors } from '../theme';

export default function PeakMomentScreen({ route, navigation }) {
  const { sessionId } = route.params;
  const [loading, setLoading] = useState(true);
  const [peakMoment, setPeakMoment] = useState(null);
  const [tier, setTier] = useState('free');
  const [busy, setBusy] = useState(false);
  const viewShotRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pm, t] = await Promise.all([
        PeakMomentService.findPeakMoment(sessionId),
        TierService.getCachedTier(),
      ]);
      if (!cancelled) {
        setPeakMoment(pm);
        setTier(t);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  async function handleShare() {
    if (!viewShotRef.current) return;
    setBusy(true);
    try {
      const uri = await viewShotRef.current.capture();
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert('Sharing not available on this device');
        return;
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png' });
    } catch (e) {
      Alert.alert('Share failed', e.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveToPhotos() {
    if (!viewShotRef.current) return;
    setBusy(true);
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow Photos access to save your Peak Moment.');
        return;
      }
      const uri = await viewShotRef.current.capture();
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert('Saved', 'Peak Moment saved to Photos.');
    } catch (e) {
      Alert.alert('Save failed', e.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Header title="🏆 Peak Moment" />
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (!peakMoment) {
    return (
      <View style={styles.center}>
        <Header title="🏆 Peak Moment" />
        <Text style={styles.emptyText}>Import your GPS data to find your peak moment</Text>
        <TouchableOpacity activeOpacity={0.7} style={styles.actionBtn} onPress={() => navigation.navigate('ImportData')}>
          <Text style={styles.actionBtnText}>Import Data</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} style={styles.closeBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.closeBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const canAttachVideo = canAccess('PEAK_MOMENT_VIDEO', tier);

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <Header title="🏆 Peak Moment" />

      {!peakMoment.skeletonFrame && (
        <Text style={styles.hintText}>
          Analyse a video from this session to add your skeleton overlay
        </Text>
      )}

      {peakMoment.weatherMissing && (
        <TouchableOpacity activeOpacity={0.7} onPress={() => navigation.navigate('ImportData')}>
          <Text style={styles.hintText}>
            No weather data for this date — run "Backfill Historical Weather" from Import Data
          </Text>
        </TouchableOpacity>
      )}

      <View style={styles.cardWrap}>
        <ViewShot ref={viewShotRef} options={{ format: 'png', quality: 1 }}>
          <PeakMomentCard peakMoment={peakMoment} tier={tier} hasVideoClip={false} />
        </ViewShot>
      </View>

      {canAttachVideo && (
        <Text style={styles.videoHint}>🎬 Ultimate: attach a video clip when sharing (coming soon)</Text>
      )}

      <View style={styles.actions}>
        <TouchableOpacity activeOpacity={0.7} style={styles.actionBtn} onPress={handleShare} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.actionBtnText}>Share</Text>}
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} style={styles.actionBtnSecondary} onPress={handleSaveToPhotos} disabled={busy}>
          <Text style={styles.actionBtnSecondaryText}>Save to Photos</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} style={styles.closeBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.closeBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.deep },
  scrollContent: { alignItems: 'center', paddingBottom: 40 },
  center: { flex: 1, backgroundColor: colors.deep, alignItems: 'center', justifyContent: 'center', padding: 24 },

  emptyText: { color: colors.text, fontSize: 15, textAlign: 'center', marginBottom: 16 },
  hintText: {
    color: 'rgba(205,232,240,0.5)', fontSize: 12, textAlign: 'center',
    paddingHorizontal: 20, marginTop: 10, marginBottom: 4,
  },
  videoHint: { color: '#f0a500', fontSize: 12, textAlign: 'center', marginTop: 10, paddingHorizontal: 20 },

  cardWrap: { marginTop: 16, borderRadius: 16, overflow: 'hidden' },

  actions: { width: '100%', paddingHorizontal: 20, marginTop: 20, gap: 10 },
  actionBtn: {
    backgroundColor: colors.accent, paddingVertical: 14, borderRadius: 12, alignItems: 'center',
  },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  actionBtnSecondary: {
    backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
    paddingVertical: 14, borderRadius: 12, alignItems: 'center',
  },
  actionBtnSecondaryText: { color: colors.text, fontWeight: '600', fontSize: 15 },
  closeBtn: { alignItems: 'center', paddingVertical: 10 },
  closeBtnText: { color: 'rgba(205,232,240,0.5)', fontSize: 14, fontWeight: '600' },
});

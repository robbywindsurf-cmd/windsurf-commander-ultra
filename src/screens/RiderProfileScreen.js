// RiderProfileScreen.js — one-time rider biometric profile (height,
// weight, inside leg, arm span). Entered once, used forever: ForceCalculator
// reads these directly rather than estimating them from video keypoints,
// which turned out too inaccurate for real lever-arm physics. Also derives
// the anonymised category key (BiometricCategory.js) used for Oracle peer
// comparison — never the exact measurements themselves.
import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput } from 'react-native';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { UserStore, getCategoryKey } from '@commandersuite/core';
import { colors } from '../theme';

const TEXT = colors.text;
const SKY = colors.accent;
const DANGER = colors.danger;

// cm -> whole {feet, inches} for pre-filling the ft/in inputs when
// switching units or loading a previously-saved profile.
function cmToFtIn(cm) {
  const totalInches = cm / 2.54;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  return { feet, inches };
}

export default function RiderProfileScreen({ navigation }) {
  const [heightCm, setHeightCmInput] = useState('');
  const [heightFt, setHeightFt] = useState('');
  const [heightIn, setHeightIn] = useState('');
  const [heightUnit, setHeightUnit] = useState('cm'); // 'cm' | 'ft'
  const [weightKg, setWeightKgInput] = useState('');
  const [weightUnit, setWeightUnit] = useState('kg'); // 'kg' | 'lbs'
  const [insideLegCm, setInsideLegCm] = useState('');
  const [armSpanCm, setArmSpanCm] = useState('');

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState([]);
  const [savedCategory, setSavedCategory] = useState(null);

  useEffect(() => {
    UserStore.getBiometrics().then((b) => {
      if (!b) return;
      setHeightCmInput(String(b.height_cm ?? ''));
      if (b.height_cm != null) {
        const { feet, inches } = cmToFtIn(b.height_cm);
        setHeightFt(String(feet));
        setHeightIn(String(inches));
      }
      setWeightKgInput(String(b.weight_kg ?? ''));
      setInsideLegCm(String(b.inside_leg_cm ?? ''));
      setArmSpanCm(String(b.arm_span_cm ?? ''));
    }).catch(() => {});
  }, []);

  // Live preview of the category key as the rider types — cleared (via the
  // null returned by getCategoryKey) until all four fields parse.
  // ft+in -> cm: (feet x 30.48) + (inches x 2.54).
  const heightCmValue = heightUnit === 'ft'
    ? (parseFloat(heightFt) || 0) * 30.48 + (parseFloat(heightIn) || 0) * 2.54
    : parseFloat(heightCm);
  const weightKgValue = weightUnit === 'lbs' ? parseFloat(weightKg) * 0.453592 : parseFloat(weightKg);
  const insideLegValue = parseFloat(insideLegCm);
  const armSpanValue = parseFloat(armSpanCm);
  const previewCategory = getCategoryKey({
    height_cm: heightCmValue,
    weight_kg: weightKgValue,
    inside_leg_cm: insideLegValue,
    arm_span_cm: armSpanValue,
  });

  async function handleSave() {
    setErrors([]);
    setSavedCategory(null);
    setSaving(true);
    try {
      const result = await UserStore.saveBiometrics({
        height_cm: Math.round(heightCmValue * 10) / 10,
        weight_kg: Math.round(weightKgValue * 10) / 10,
        inside_leg_cm: Math.round(insideLegValue * 10) / 10,
        arm_span_cm: Math.round(armSpanValue * 10) / 10,
      });
      setSavedCategory(result.categoryKey);
    } catch (err) {
      setErrors([err.message || 'Failed to save profile.']);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.container} style={styles.scrollBg} keyboardShouldPersistTaps="handled">
      <Header title="🏄 Rider Profile" />
      <TouchableOpacity activeOpacity={0.7} style={styles.closeBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.closeBtnText}>‹ Back</Text>
      </TouchableOpacity>

      <SharedCard style={styles.introCard}>
        <Text style={styles.introText}>
          Your measurements are used to calculate accurate foot pressure and fin loading. Measured once — used in every analysis.
        </Text>
      </SharedCard>

      <Text style={styles.sectionLabel}>HEIGHT</Text>
      <SharedCard style={styles.card}>
        <View style={styles.unitToggleRow}>
          <TouchableOpacity activeOpacity={0.7} onPress={() => setHeightUnit('cm')} style={[styles.unitBtn, heightUnit === 'cm' && styles.unitBtnActive]}>
            <Text style={styles.unitBtnText}>cm</Text>
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.7} onPress={() => setHeightUnit('ft')} style={[styles.unitBtn, heightUnit === 'ft' && styles.unitBtnActive]}>
            <Text style={styles.unitBtnText}>ft+in</Text>
          </TouchableOpacity>
        </View>
        {heightUnit === 'ft' ? (
          <View style={styles.ftInRow}>
            <TextInput
              style={[styles.input, styles.ftInInput]}
              placeholder="feet"
              placeholderTextColor="rgba(205,232,240,0.35)"
              keyboardType="number-pad"
              value={heightFt}
              onChangeText={setHeightFt}
            />
            <TextInput
              style={[styles.input, styles.ftInInput]}
              placeholder="inches"
              placeholderTextColor="rgba(205,232,240,0.35)"
              keyboardType="number-pad"
              value={heightIn}
              onChangeText={setHeightIn}
            />
          </View>
        ) : (
          <TextInput
            style={styles.input}
            placeholder="e.g. 174"
            placeholderTextColor="rgba(205,232,240,0.35)"
            keyboardType="decimal-pad"
            value={heightCm}
            onChangeText={setHeightCmInput}
          />
        )}
        <Text style={styles.howToText}>
          How to measure: stand straight against a wall, mark the top of your head, measure from floor to mark.
        </Text>
      </SharedCard>

      <Text style={styles.sectionLabel}>WEIGHT</Text>
      <SharedCard style={styles.card}>
        <View style={styles.unitToggleRow}>
          <TouchableOpacity activeOpacity={0.7} onPress={() => setWeightUnit('kg')} style={[styles.unitBtn, weightUnit === 'kg' && styles.unitBtnActive]}>
            <Text style={styles.unitBtnText}>kg</Text>
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.7} onPress={() => setWeightUnit('lbs')} style={[styles.unitBtn, weightUnit === 'lbs' && styles.unitBtnActive]}>
            <Text style={styles.unitBtnText}>lbs</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.input}
          placeholder={weightUnit === 'lbs' ? 'e.g. 159' : 'e.g. 72.0'}
          placeholderTextColor="rgba(205,232,240,0.35)"
          keyboardType="decimal-pad"
          value={weightKg}
          onChangeText={setWeightKgInput}
        />
        <Text style={styles.howToText}>Use your current body weight, including wetsuit if worn on the water.</Text>
      </SharedCard>

      <Text style={styles.sectionLabel}>INSIDE LEG</Text>
      <SharedCard style={styles.card}>
        <TextInput
          style={styles.input}
          placeholder="cm — e.g. 83"
          placeholderTextColor="rgba(205,232,240,0.35)"
          keyboardType="decimal-pad"
          value={insideLegCm}
          onChangeText={setInsideLegCm}
        />
        <Text style={styles.howToText}>
          How to measure: stand straight with feet together, measure from floor to crotch (same as a trouser inside-leg measurement).
        </Text>
      </SharedCard>

      <Text style={styles.sectionLabel}>ARM SPAN</Text>
      <SharedCard style={styles.card}>
        <TextInput
          style={styles.input}
          placeholder="cm — e.g. 182"
          placeholderTextColor="rgba(205,232,240,0.35)"
          keyboardType="decimal-pad"
          value={armSpanCm}
          onChangeText={setArmSpanCm}
        />
        <Text style={styles.howToText}>
          How to measure: stand against a wall, stretch both arms out sideways, measure fingertip to fingertip.
        </Text>
      </SharedCard>

      {previewCategory && (
        <SharedCard style={styles.categoryCard}>
          <Text style={styles.categoryLabel}>YOUR CATEGORY</Text>
          <Text style={styles.categoryValue}>{previewCategory}</Text>
        </SharedCard>
      )}

      {errors.map((e, i) => (
        <Text key={i} style={styles.errorText}>⚠️ {e}</Text>
      ))}

      {!!savedCategory && (
        <SharedCard style={styles.savedCard}>
          <Text style={styles.savedText}>Profile saved ✅</Text>
          <Text style={styles.savedSubtext}>Your category: {savedCategory}</Text>
          <Text style={styles.savedSubtext}>This category is used to find similar riders in our coaching database.</Text>
        </SharedCard>
      )}

      <TouchableOpacity
        activeOpacity={0.7}
        style={[styles.saveBtn, (!previewCategory || saving) && styles.saveBtnDisabled]}
        onPress={handleSave}
        disabled={!previewCategory || saving}
      >
        <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save Profile'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, paddingBottom: 40 },
  closeBtn: { paddingVertical: 4, marginBottom: 8 },
  closeBtnText: { color: SKY, fontSize: 14, fontWeight: '600' },

  introCard: { marginBottom: 16 },
  introText: { color: TEXT, fontSize: 13, lineHeight: 19 },

  sectionLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(205,232,240,0.35)', marginBottom: 6, marginTop: 4 },
  card: { marginBottom: 14 },

  unitToggleRow: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  unitBtn: {
    paddingVertical: 4, paddingHorizontal: 12, borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  unitBtnActive: { backgroundColor: 'rgba(26,138,181,0.3)', borderColor: SKY },
  unitBtnText: { color: TEXT, fontSize: 12, fontWeight: '600' },

  input: {
    backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    color: TEXT, fontSize: 16, marginBottom: 8,
  },
  ftInRow: { flexDirection: 'row', gap: 8 },
  ftInInput: { flex: 1 },
  howToText: { color: 'rgba(205,232,240,0.5)', fontSize: 11, lineHeight: 16 },

  categoryCard: { marginBottom: 14, alignItems: 'center' },
  categoryLabel: { color: 'rgba(205,232,240,0.5)', fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  categoryValue: { color: SKY, fontSize: 13, fontWeight: '700', textAlign: 'center' },

  errorText: { color: DANGER, fontSize: 13, marginBottom: 8, textAlign: 'center' },

  savedCard: { marginBottom: 14, backgroundColor: 'rgba(42,122,59,0.15)', borderColor: 'rgba(42,122,59,0.4)' },
  savedText: { color: colors.green, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  savedSubtext: { color: TEXT, fontSize: 12, marginTop: 2 },

  saveBtn: {
    backgroundColor: SKY, borderRadius: 14, paddingVertical: 14,
    alignItems: 'center', justifyContent: 'center', marginTop: 8,
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});

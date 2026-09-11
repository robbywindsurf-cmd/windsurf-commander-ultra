import React from 'react';
import { ScrollView, Text, View, TouchableOpacity, StyleSheet } from 'react-native';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { colors } from '../theme';

const TIERS = [
  {
    key: 'premium',
    name: 'Premium',
    price: '£4.99/mo',
    features: [
      'Full biomechanics analysis (5/month)',
      'AI coaching reports (5/month)',
      'Skeleton overlay history',
      'Peer comparison',
      'Up to 5 custom beaches',
      'Telegram + Alexa integrations',
    ],
  },
  {
    key: 'ultimate',
    name: 'Ultimate',
    price: '£9.99/mo',
    features: [
      'Everything in Premium, higher limits',
      'Cloud RAG coaching',
      'Unlimited beaches',
      '9-axis IMU support',
      'Peak moment video export',
    ],
  },
];

export default function UpgradeScreen({ navigation }) {
  return (
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge="Unlock more" title="⭐ Upgrade" />

      {TIERS.map((tier) => (
        <SharedCard key={tier.key}>
          <Text style={styles.tierName}>{tier.name} — {tier.price}</Text>
          {tier.features.map((f) => (
            <Text key={f} style={styles.feature}>• {f}</Text>
          ))}
          <TouchableOpacity style={styles.button} onPress={() => {}}>
            <Text style={styles.buttonText}>Choose {tier.name}</Text>
          </TouchableOpacity>
        </SharedCard>
      ))}

      <TouchableOpacity style={styles.closeBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.closeBtnText}>Maybe later</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  tierName: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 10 },
  feature: { color: 'rgba(205,232,240,0.7)', fontSize: 13, marginBottom: 6 },
  button: { backgroundColor: colors.accent, padding: 12, borderRadius: 10, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  closeBtn: { padding: 12, alignItems: 'center', marginTop: 8 },
  closeBtnText: { color: 'rgba(205,232,240,0.5)', fontSize: 13 },
});

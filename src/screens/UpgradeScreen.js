import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { UserStore, TierService, RevenueCatService, getFeatureDefinition } from '@commandersuite/core';
import { colors } from '../theme';

const PREMIUM_FEATURES = [
  '5 analyses per month',
  'Full skeleton overlay',
  'AI coaching reports',
  'Cross-session comparison',
  '5 peer comparisons/month',
  'Custom beach list (5 beaches)',
  'IMU 6-axis integration',
  'Morning weather via Telegram',
  'Peak Moment (no watermark)',
];

const ULTIMATE_FEATURES = [
  'Everything in Premium, plus:',
  '12 analyses per month',
  'Global cloud RAG analysis',
  'Unlimited beaches',
  'Unlimited peer comparison',
  'IMU 9-axis',
  'Peak Moment video export',
];

export default function UpgradeScreen({ route, navigation }) {
  const featureId = route?.params?.featureId;
  const [offerings, setOfferings] = useState(null);
  const [offeringsError, setOfferingsError] = useState(null);
  const [loadingOfferings, setLoadingOfferings] = useState(true);
  const [purchasingKey, setPurchasingKey] = useState(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const current = await RevenueCatService.getOfferings();
        setOfferings(current);
      } catch (err) {
        // Expected right now — RevenueCatService.configure() hasn't been
        // called anywhere yet (no real API keys/products configured for
        // this phase). Pricing below is still shown from static copy;
        // purchase falls back to setting the tier locally.
        setOfferingsError(err.message);
      } finally {
        setLoadingOfferings(false);
      }
    })();
  }, []);

  function findPackage(tierKey, cycle) {
    if (!offerings) return null;
    const identifierHint = `${tierKey}_${cycle}`; // e.g. "premium_monthly" — matches typical RC package identifiers
    return offerings.availablePackages?.find((p) =>
      p.identifier?.toLowerCase().includes(identifierHint) || p.identifier?.toLowerCase().includes(tierKey)
    ) || null;
  }

  async function purchase(tierKey, cycle) {
    const purchaseKey = `${tierKey}_${cycle}`;
    setPurchasingKey(purchaseKey);
    try {
      const pkg = findPackage(tierKey, cycle);
      if (pkg) {
        await RevenueCatService.purchasePackage(pkg);
        await TierService.refreshTier();
      } else {
        // No matching RevenueCat package (not configured, or dashboard
        // doesn't have this product yet) — set the tier locally so the
        // rest of the app can still be tested against it.
        await UserStore.saveUser({ appleId: null, tier: tierKey });
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Purchase failed', err.message || 'Something went wrong. Please try again.');
    } finally {
      setPurchasingKey(null);
    }
  }

  async function restore() {
    setRestoring(true);
    try {
      await RevenueCatService.restorePurchases();
      await TierService.refreshTier();
      Alert.alert('Restored', 'Your purchases have been restored.');
    } catch (err) {
      Alert.alert('Could not restore purchases', err.message || 'Please try again later.');
    } finally {
      setRestoring(false);
    }
  }

  function showComingSoon(label) {
    Alert.alert(label, 'Not available yet.');
  }

  let featureBanner = null;
  if (featureId) {
    try {
      const def = getFeatureDefinition(featureId);
      const tierLabel = def.minTier.charAt(0).toUpperCase() + def.minTier.slice(1);
      featureBanner = `You need ${tierLabel} to access ${def.description}`;
    } catch {
      featureBanner = null;
    }
  }

  return (
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Text style={styles.title}>Unlock Windsurf Commander Ultra</Text>
      <Text style={styles.subtitle}>Get the most from every session</Text>

      {!!featureBanner && (
        <View style={styles.featureBanner}>
          <Text style={styles.featureBannerText}>🔒 {featureBanner}</Text>
        </View>
      )}

      {loadingOfferings && (
        <ActivityIndicator color={colors.accent} style={{ marginVertical: 12 }} />
      )}
      {!!offeringsError && (
        <Text style={styles.previewNotice}>Preview mode — live pricing not connected yet.</Text>
      )}

      {/* Premium */}
      <View style={[styles.card, styles.cardPremium]}>
        <Text style={styles.tierName}>Premium</Text>
        <Text style={styles.tierPrice}>£4.99/month <Text style={styles.tierPriceOr}>or</Text> £39.99/year</Text>

        {PREMIUM_FEATURES.map((f) => (
          <Text key={f} style={styles.feature}>✅ {f}</Text>
        ))}

        <TouchableOpacity
          style={[styles.ctaBtn, styles.ctaBtnPremium]}
          onPress={() => purchase('premium', 'monthly')}
          disabled={purchasingKey === 'premium_monthly'}
        >
          {purchasingKey === 'premium_monthly'
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.ctaBtnText}>Start Free Trial</Text>}
        </TouchableOpacity>

        <View style={styles.yearlyRow}>
          <TouchableOpacity
            style={[styles.ctaBtnSecondary, styles.ctaBtnSecondaryPremium]}
            onPress={() => purchase('premium', 'monthly')}
            disabled={purchasingKey === 'premium_monthly'}
          >
            <Text style={styles.ctaBtnSecondaryText}>£4.99/month</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.ctaBtnSecondary, styles.ctaBtnSecondaryPremium]}
            onPress={() => purchase('premium', 'yearly')}
            disabled={purchasingKey === 'premium_yearly'}
          >
            <View style={styles.bestValueBadge}>
              <Text style={styles.bestValueBadgeText}>BEST VALUE</Text>
            </View>
            <Text style={styles.ctaBtnSecondaryText}>£39.99/year</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Ultimate */}
      <View style={[styles.card, styles.cardUltimate]}>
        <Text style={styles.tierName}>Ultimate</Text>
        <Text style={styles.tierPrice}>£9.99/month <Text style={styles.tierPriceOr}>or</Text> £90/year</Text>

        {ULTIMATE_FEATURES.map((f) => (
          <Text key={f} style={f.endsWith(':') ? styles.featureHeading : styles.feature}>
            {f.endsWith(':') ? f : `✅ ${f}`}
          </Text>
        ))}

        <View style={styles.yearlyRow}>
          <TouchableOpacity
            style={[styles.ctaBtnSecondary, styles.ctaBtnSecondaryUltimate]}
            onPress={() => purchase('ultimate', 'monthly')}
            disabled={purchasingKey === 'ultimate_monthly'}
          >
            {purchasingKey === 'ultimate_monthly'
              ? <ActivityIndicator color={colors.amber} size="small" />
              : <Text style={[styles.ctaBtnSecondaryText, { color: colors.amber }]}>£9.99/month</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.ctaBtnSecondary, styles.ctaBtnSecondaryUltimate]}
            onPress={() => purchase('ultimate', 'yearly')}
            disabled={purchasingKey === 'ultimate_yearly'}
          >
            <View style={styles.bestValueBadge}>
              <Text style={styles.bestValueBadgeText}>BEST VALUE</Text>
            </View>
            {purchasingKey === 'ultimate_yearly'
              ? <ActivityIndicator color={colors.amber} size="small" />
              : <Text style={[styles.ctaBtnSecondaryText, { color: colors.amber }]}>£90/year</Text>}
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.reassurance}>Cancel anytime — no long-term commitment.</Text>

      <View style={styles.footerLinks}>
        <TouchableOpacity onPress={restore} disabled={restoring}>
          <Text style={styles.footerLink}>{restoring ? 'Restoring…' : 'Restore Purchase'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => showComingSoon('Terms of Service')}>
          <Text style={styles.footerLink}>Terms of Service</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => showComingSoon('Privacy Policy')}>
          <Text style={styles.footerLink}>Privacy Policy</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.closeBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.closeBtnText}>Maybe later</Text>
      </TouchableOpacity>

      {/* Dev-only: no downgrade flow exists yet (RevenueCat isn't configured),
          so this is the only way to test free-tier behaviour again. */}
      <TouchableOpacity style={styles.devResetBtn} onPress={() => purchase('free', null)}>
        <Text style={styles.devResetBtnText}>Reset to Free (dev)</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 20, flexGrow: 1, paddingBottom: 40 },

  title: { color: '#fff', fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  subtitle: { color: 'rgba(205,232,240,0.5)', fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: 16 },

  featureBanner: {
    backgroundColor: 'rgba(240,165,0,0.12)', borderWidth: 1, borderColor: 'rgba(240,165,0,0.3)',
    borderRadius: 10, padding: 12, marginBottom: 12,
  },
  featureBannerText: { color: colors.amber, fontSize: 13, textAlign: 'center', fontWeight: '600' },
  previewNotice: { color: 'rgba(205,232,240,0.4)', fontSize: 11, textAlign: 'center', marginBottom: 8, fontStyle: 'italic' },

  card: {
    backgroundColor: 'rgba(26,138,181,0.06)', borderRadius: 16, padding: 18,
    marginBottom: 16, borderWidth: 2,
  },
  cardPremium: { borderColor: colors.accent },
  cardUltimate: { borderColor: colors.amber },

  tierName: { color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 },
  tierPrice: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 14 },
  tierPriceOr: { color: 'rgba(205,232,240,0.4)', fontWeight: '400', fontSize: 13 },

  feature: { color: 'rgba(205,232,240,0.8)', fontSize: 13, marginBottom: 7, lineHeight: 18 },
  featureHeading: { color: colors.text, fontSize: 13, fontWeight: '700', marginBottom: 7, marginTop: 2 },

  ctaBtn: { paddingVertical: 13, borderRadius: 10, alignItems: 'center', marginTop: 10 },
  ctaBtnPremium: { backgroundColor: colors.accent },
  ctaBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  yearlyRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  ctaBtnSecondary: {
    flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center',
    borderWidth: 1, position: 'relative',
  },
  ctaBtnSecondaryPremium: { borderColor: colors.accent, backgroundColor: 'rgba(26,138,181,0.1)' },
  ctaBtnSecondaryUltimate: { borderColor: colors.amber, backgroundColor: 'rgba(240,165,0,0.1)' },
  ctaBtnSecondaryText: { color: colors.accent, fontWeight: '700', fontSize: 13 },

  bestValueBadge: {
    position: 'absolute', top: -10, alignSelf: 'center',
    backgroundColor: colors.amber, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  bestValueBadgeText: { color: '#061f2e', fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },

  reassurance: { color: 'rgba(205,232,240,0.5)', fontSize: 12, textAlign: 'center', marginTop: 4, marginBottom: 16 },

  footerLinks: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: 12 },
  footerLink: { color: colors.accent, fontSize: 12, fontWeight: '600' },

  closeBtn: { padding: 12, alignItems: 'center' },
  closeBtnText: { color: 'rgba(205,232,240,0.5)', fontSize: 13 },
  devResetBtn: { padding: 8, alignItems: 'center' },
  devResetBtnText: { color: 'rgba(230,57,70,0.7)', fontSize: 11, fontWeight: '600' },
});

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';

// Used as the first element on nearly every screen (tab screens and pushed
// stack screens alike), none of which are individually wrapped in a
// SafeAreaView — so this is where Dynamic Island / notch clearance for the
// whole app actually lives. A bare paddingTop here would sit under the
// Dynamic Island on iPhone 14/15 Pro.
// `right` is optional — a small action (e.g. a refresh button) rendered in
// the top-right corner alongside the title. Omitting it keeps every other
// screen's Header pixel-identical to before.
export default function Header({ badge, title, right }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingBottom: 8, paddingHorizontal: 12, backgroundColor: colors.deep },
  badge: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  right: { marginLeft: 12 },
});

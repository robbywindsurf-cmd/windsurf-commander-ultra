import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import WeightTrendChart from '../components/WeightTrendChart';
import { StatsService } from '../services/StatsService';
import { colors } from '../theme';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const QUICK_ANALYSIS_CARDS = [
  { emoji: '🪂', label: 'Best Sail', question: 'Which of my sails gives the best peak speeds?' },
  { emoji: '💨', label: 'Best Wind', question: 'What wind speed and direction gives my best performance?' },
  { emoji: '📊', label: 'Board Compare', question: 'Compare my performance across all my boards' },
  { emoji: '📈', label: 'Progression', question: 'Show me my year on year progression' },
];

const FULL_ANALYSIS_QUESTION =
  'Give me a comprehensive performance analysis of all my sessions including speed progression, ' +
  'best conditions, gear performance and recommendations to improve';

export default function StatsScreen({ navigation }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const currentYear = String(new Date().getFullYear());

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoading(true);
        try {
          const result = await StatsService.getStats();
          if (!cancelled) setStats(result);
        } catch (err) {
          console.warn('[Stats] load error:', err.message);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }, [])
  );

  function goToChat(question) {
    navigation.navigate('MainTabs', { screen: 'Chat', params: { initialQuestion: question } });
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Header title="📊 Stats" />
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  const { personalBest, grid, yearByYear, moneyTack, lowSpeedPercentage, weightLog } = stats || {};
  const bestYearKn = yearByYear?.length ? Math.max(...yearByYear.map((y) => y.best_kn || 0)) : null;

  return (
    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={true} contentInsetAdjustmentBehavior="automatic" style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header title="📊 Stats" />
      <TouchableOpacity activeOpacity={0.7} style={styles.closeBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.closeBtnText}>‹ Back</Text>
      </TouchableOpacity>

      {/* Personal best speed */}
      <SharedCard style={styles.pbCard}>
        <Text style={styles.pbSpeed}>{personalBest?.speedKn != null ? personalBest.speedKn.toFixed(1) : '—'} <Text style={styles.pbUnit}>kn</Text></Text>
        {personalBest && (
          <Text style={styles.pbContext}>
            {formatDate(personalBest.date)}
            {personalBest.windDirText ? ` • ${personalBest.windDirText} heading` : ''}
            {personalBest.boardName ? ` • ${personalBest.boardName}` : ''}
            {personalBest.sailName ? ` + ${personalBest.sailName}${personalBest.sailSize ? ` ${personalBest.sailSize}m²` : ''}` : ''}
          </Text>
        )}
      </SharedCard>

      {/* Stats grid */}
      <View style={styles.grid}>
        <SharedCard style={styles.gridCell}>
          <Text style={styles.gridValue}>{grid?.totalSessions ?? 0}</Text>
          <Text style={styles.gridLabel}>Sessions</Text>
          <Text style={styles.gridSub}>{grid?.earliestDate ? `${formatDate(grid.earliestDate)} – present` : '—'}</Text>
        </SharedCard>
        <SharedCard style={styles.gridCell}>
          <Text style={styles.gridValue}>{grid?.totalHours != null ? grid.totalHours.toFixed(0) : '—'}</Text>
          <Text style={styles.gridLabel}>Hours</Text>
          <Text style={styles.gridSub}>On the water</Text>
        </SharedCard>
        <SharedCard style={styles.gridCell}>
          <Text style={styles.gridValue}>{grid?.avgPeakKn != null ? grid.avgPeakKn.toFixed(1) : '—'}</Text>
          <Text style={styles.gridLabel}>Avg Peak</Text>
          <Text style={styles.gridSub}>Per session</Text>
        </SharedCard>
        <SharedCard style={styles.gridCell}>
          <Text style={styles.gridValue}>{formatDate(grid?.lastOut)}</Text>
          <Text style={styles.gridLabel}>Last Out</Text>
          <Text style={styles.gridSub}> </Text>
        </SharedCard>
      </View>

      {/* Year by year */}
      {yearByYear?.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>Year by Year</Text>
          <SharedCard>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.tableHeaderText, styles.colYear]}>Year</Text>
              <Text style={[styles.tableHeaderText, styles.colNum]}>Sessions</Text>
              <Text style={[styles.tableHeaderText, styles.colNum]}>Best</Text>
              <Text style={[styles.tableHeaderText, styles.colNum]}>Hours</Text>
            </View>
            {yearByYear.map((row) => {
              const isBestYear = row.best_kn === bestYearKn && bestYearKn != null;
              const isCurrent = row.year === currentYear;
              return (
                <View key={row.year} style={[styles.tableRow, isBestYear && styles.tableRowGold]}>
                  <Text style={[styles.tableCell, styles.colYear]}>{row.year}{isCurrent ? ' ↗' : ''}</Text>
                  <Text style={[styles.tableCell, styles.colNum]}>{row.sessions}</Text>
                  <Text style={[styles.tableCell, styles.colNum, styles.goldText]}>{row.best_kn != null ? row.best_kn.toFixed(1) : '—'}</Text>
                  <Text style={[styles.tableCell, styles.colNum]}>{row.hours != null ? row.hours.toFixed(1) : '—'}</Text>
                </View>
              );
            })}
          </SharedCard>
        </>
      )}

      {/* Key insights */}
      <Text style={styles.sectionLabel}>Key Insights</Text>
      {moneyTack && (
        <SharedCard>
          <Text style={styles.insightTitle}>💰 Money Tack</Text>
          <Text style={styles.insightBody}>
            {moneyTack.headingText} heading ({Math.max(0, moneyTack.headingBucket - 10)}-{moneyTack.headingBucket + 10}°)
            {moneyTack.beachName ? ` at ${moneyTack.beachName}` : ''}
            {moneyTack.windDirText ? ` — ${moneyTack.windDirText} winds${moneyTack.windDirDeg != null ? ` at ${moneyTack.windDirDeg}°` : ''}` : ''}
          </Text>
          <Text style={styles.insightSub}>Avg {moneyTack.avgSpeedKn}kn on this heading</Text>
        </SharedCard>
      )}
      {lowSpeedPercentage != null && (
        <SharedCard>
          <Text style={styles.insightTitle}>📉 Biggest Gain</Text>
          <Text style={styles.insightBody}>
            {lowSpeedPercentage}% of session time at 0-2 knots — carve gybes instead of tacks to maintain momentum
          </Text>
        </SharedCard>
      )}

      {/* Quick analysis */}
      <Text style={styles.sectionLabel}>Quick Analysis</Text>
      <View style={styles.quickGrid}>
        {QUICK_ANALYSIS_CARDS.map((c) => (
          <TouchableOpacity activeOpacity={0.7} key={c.label} style={styles.quickCard} onPress={() => goToChat(c.question)}>
            <Text style={styles.quickCardEmoji}>{c.emoji}</Text>
            <Text style={styles.quickCardLabel}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity activeOpacity={0.7} style={styles.fullAnalysisBtn} onPress={() => goToChat(FULL_ANALYSIS_QUESTION)}>
        <Text style={styles.fullAnalysisBtnText}>🤖 Full AI Performance Analysis</Text>
      </TouchableOpacity>

      {/* Weight trend */}
      {weightLog?.length >= 2 && (
        <>
          <Text style={styles.sectionLabel}>Weight Trend</Text>
          <SharedCard>
            <WeightTrendChart entries={weightLog} width={310} />
          </SharedCard>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  center: { flex: 1, backgroundColor: colors.deep, alignItems: 'center', justifyContent: 'center' },

  closeBtn: { paddingVertical: 4, marginBottom: 8 },
  closeBtnText: { color: colors.accent, fontSize: 14, fontWeight: '600' },

  sectionLabel: {
    color: 'rgba(205,232,240,0.5)', fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8, marginTop: 18,
  },

  pbCard: { alignItems: 'center', paddingVertical: 20 },
  pbSpeed: { color: colors.amber, fontSize: 48, fontWeight: '900' },
  pbUnit: { fontSize: 20, fontWeight: '700' },
  pbContext: { color: colors.text, fontSize: 12, marginTop: 8, textAlign: 'center' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gridCell: { width: '47%', alignItems: 'center', paddingVertical: 16 },
  gridValue: { color: '#fff', fontSize: 24, fontWeight: '800' },
  gridLabel: { color: 'rgba(205,232,240,0.6)', fontSize: 11, fontWeight: '700', marginTop: 4, textTransform: 'uppercase', letterSpacing: 1 },
  gridSub: { color: 'rgba(205,232,240,0.4)', fontSize: 10, marginTop: 4, textAlign: 'center' },

  tableHeaderRow: { flexDirection: 'row', paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(26,138,181,0.2)' },
  tableHeaderText: { color: 'rgba(205,232,240,0.4)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  tableRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(26,138,181,0.08)' },
  tableRowGold: { backgroundColor: 'rgba(240,165,0,0.08)' },
  tableCell: { color: colors.text, fontSize: 13 },
  colYear: { flex: 1.2 },
  colNum: { flex: 1, textAlign: 'right' },
  goldText: { color: colors.amber, fontWeight: '700' },

  insightTitle: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 6 },
  insightBody: { color: colors.text, fontSize: 13, lineHeight: 19 },
  insightSub: { color: 'rgba(205,232,240,0.4)', fontSize: 11, marginTop: 6 },

  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  quickCard: {
    width: '47%', alignItems: 'center', paddingVertical: 16, borderRadius: 12,
    backgroundColor: 'rgba(26,138,181,0.08)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.3)',
  },
  quickCardEmoji: { fontSize: 22, marginBottom: 6 },
  quickCardLabel: { color: colors.text, fontSize: 12, fontWeight: '700' },

  fullAnalysisBtn: {
    backgroundColor: colors.accent, paddingVertical: 14, borderRadius: 12,
    alignItems: 'center', marginTop: 12,
  },
  fullAnalysisBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});

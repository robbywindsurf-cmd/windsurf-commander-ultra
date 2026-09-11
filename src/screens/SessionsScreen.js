import React, { useCallback, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SessionRepository } from '@commandersuite/core';
import Header from '../components/Header';
import SharedCard from '../components/SharedCard';
import { colors } from '../theme';

export default function SessionsScreen({ navigation }) {
  const [sessions, setSessions] = useState([]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const all = await SessionRepository.getAll();
          if (!cancelled) setSessions(all);
        } catch (err) {
          console.warn('[Sessions] load error:', err.message);
        }
      })();
      return () => { cancelled = true; };
    }, [])
  );

  return (
    <ScrollView style={styles.scrollBg} contentContainerStyle={styles.container}>
      <Header badge={`${sessions.length} sessions`} title="📅 Sessions" />

      {sessions.length === 0 ? (
        <Text style={styles.emptyText}>No sessions yet. Import a FIT file to get started.</Text>
      ) : (
        sessions.map((s) => (
          <TouchableOpacity
            key={s.session_id}
            onPress={() => navigation.navigate('SessionDetail', { sessionId: s.session_id })}
          >
            <SharedCard>
              <Text style={styles.title}>{s.date} {s.start_time ? `· ${s.start_time}` : ''}</Text>
              <Text style={styles.meta}>
                {s.max_speed_kn ? `${s.max_speed_kn.toFixed(1)} kn max` : 'No speed data'}
                {s.distance_m ? ` · ${(s.distance_m / 1000).toFixed(1)} km` : ''}
                {s.duration_s ? ` · ${Math.round(s.duration_s / 60)} min` : ''}
              </Text>
            </SharedCard>
          </TouchableOpacity>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollBg: { backgroundColor: colors.deep },
  container: { padding: 16, flexGrow: 1, paddingBottom: 40 },
  title: { color: colors.text, fontWeight: '600', fontSize: 14, marginBottom: 4 },
  meta: { color: 'rgba(205,232,240,0.5)', fontSize: 12 },
  emptyText: { color: 'rgba(205,232,240,0.4)', fontSize: 13, textAlign: 'center', marginTop: 20 },
});

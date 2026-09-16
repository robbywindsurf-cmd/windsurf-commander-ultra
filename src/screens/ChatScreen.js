// ChatScreen.js — AI coach chat, Premium+ only.
// Adapted from the production app's ChatScreen.js: no Oracle webhook, no
// remote AI. Context (recent sessions, last analysis, weather, equipment)
// is pulled from local SQLite and passed to commander-core's CoachingService,
// which runs Phi-3 Mini on-device via llama.rn once the model is downloaded.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  TierService, CoachingService, ModelManager, UserStore,
  SessionRepository, AnalysisRepository, WeatherRepository, EquipmentRepository,
} from '@commandersuite/core';
import Header from '../components/Header';
import { fetchBeachWeather, isWeatherStale } from '../services/WeatherService';
import { ALL_BEACHES } from '../utils/seedBeaches';
import { colors } from '../theme';

// Same key WeatherScreen stores the picker selection under — Chat reads
// the rider's actual tracked-beach list rather than keeping its own copy.
const WEATHER_SELECTION_KEY = 'ws_selected_beach_names';

const SUGGESTED_QUESTIONS = [
  { emoji: '🏆', label: 'What is my real personal best?', question: 'What is my real personal best?' },
  { emoji: '🪂', label: 'Best sail for speed?', question: 'Best sail for speed?' },
  { emoji: '💨', label: 'Best wind direction?', question: 'Best wind direction?' },
  { emoji: '📈', label: 'Year on year progress?', question: 'Year on year progress?' },
  { emoji: '🚀', label: 'How to break 30 knots?', question: 'How to break 30 knots?' },
  { emoji: '❤️', label: 'Most intense sessions?', question: 'Most intense sessions?' },
  { emoji: '❤️', label: 'HR vs speed analysis?', question: 'HR vs speed analysis?' },
  { emoji: '🌊', label: 'Best conditions for my fastest sessions?', question: 'Best conditions for my fastest sessions?' },
  { emoji: '⚙️', label: 'Which gear combo performs best?', question: 'Which gear combo performs best?' },
  { emoji: '📅', label: 'How many sessions this year vs last year?', question: 'How many sessions this year vs last year?' },
];

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ThinkingDots() {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const seq = ['', '.', '..', '...'];
    let i = 0;
    const t = setInterval(() => { i = (i + 1) % seq.length; setDots(seq[i]); }, 375);
    return () => clearInterval(t);
  }, []);
  return <Text style={styles.thinkingText}>Thinking{dots}</Text>;
}

function ChatUpgradePrompt({ navigation }) {
  return (
    <View style={styles.upgradeScreen}>
      <Header title="💬 Chat" />
      <View style={styles.upgradeBody}>
        <Text style={styles.upgradeIcon}>🔒</Text>
        <Text style={styles.upgradeTitle}>Chat with your AI coach is a Premium feature</Text>
        <Text style={styles.upgradeSub}>Upgrade to ask questions about your sessions</Text>
        <TouchableOpacity activeOpacity={0.7} style={styles.upgradeBtn} onPress={() => navigation.navigate('Upgrade')}>
          <Text style={styles.upgradeBtnText}>Upgrade</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function ChatScreen({ navigation, route }) {
  const [tier, setTier] = useState(null); // null = still resolving
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [modelDownloaded, setModelDownloaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const listRef = useRef(null);

  useFocusEffect(useCallback(() => {
    TierService.getCachedTier().then(setTier);
    ModelManager.isModelDownloaded().then(setModelDownloaded);
  }, []));

  useEffect(() => {
    const initial = route?.params?.initialQuestion;
    if (initial) {
      send(initial);
      navigation.setParams({ initialQuestion: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.params?.initialQuestion]);

  const handleDownloadModel = async () => {
    setDownloading(true);
    setDownloadProgress(0);
    try {
      await ModelManager.downloadModel((progress) => setDownloadProgress(progress));
      setModelDownloaded(true);
    } catch (e) {
      // leave modelDownloaded false; user can retry
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    if (messages.length) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages]);

  // Weather is normally already cached by the time Chat is opened (App.js
  // warms the favourite beach in the background on launch, WeatherScreen
  // refreshes on focus) — but if Chat is the very first screen touched
  // this session, or a cached row has gone stale, weather_cache can be
  // genuinely empty/outdated for some beaches. Rather than have the AI say
  // "no weather data" in that case, fetch it live before answering.
  //
  // Covers every beach the rider actually tracks (their WeatherScreen
  // picker selection, plus favourite) — not just one. Deliberately never
  // uses WeatherRepository.getAllToday(): that returns whichever cached
  // beach happens to have the highest wind today across the *whole*
  // table, which silently fed the AI a different beach's conditions
  // whenever it was windier than anywhere the rider actually goes.
  async function buildContext() {
    let [recentSessions, lastAnalysis, equipment] = await Promise.all([
      SessionRepository.getRecentSessions(3),
      AnalysisRepository.getLatestAnalysis(),
      EquipmentRepository.getAll(),
    ]);

    const [storedNames, favouriteBeach] = await Promise.all([
      AsyncStorage.getItem(WEATHER_SELECTION_KEY),
      UserStore.getFavouriteBeach(),
    ]);
    const trackedNames = new Set(storedNames ? JSON.parse(storedNames) : []);
    if (favouriteBeach) trackedNames.add(favouriteBeach.name);

    const today = new Date().toISOString().slice(0, 10);
    const weather = [];
    for (const name of trackedNames) {
      const beach = ALL_BEACHES.find((b) => b.name === name);
      if (!beach) continue;

      let row = await WeatherRepository.getForBeach(beach.name, today);
      if (!row || isWeatherStale(row)) {
        console.log(!row ? `[Chat] No weather cached for ${beach.name} — fetching...` : `[Chat] Cached weather stale for ${beach.name} — fetching...`);
        try {
          row = await fetchBeachWeather(beach);
          await WeatherRepository.cache(row);
        } catch (err) {
          console.warn('[Chat] live weather fetch failed for', beach.name, err.message);
          // Keep whatever stale row exists rather than dropping the beach
          // entirely — some grounding beats none.
        }
      }
      if (row) weather.push(row);
    }
    console.log('[Chat] weather for prompt:', JSON.stringify(weather)?.slice(0, 400));

    return { recentSessions, lastAnalysis, weather, equipment };
  }

  const send = async (msgText) => {
    const msg = (msgText || input).trim();
    if (!msg || sending) return;

    const userMsg = { id: makeId(), text: msg, from: 'user' };
    const thinkingMsg = { id: makeId(), from: 'thinking' };
    setMessages((prev) => [...prev, userMsg, thinkingMsg]);
    setInput('');
    setSending(true);

    try {
      const context = await buildContext();
      const answer = await CoachingService.answerQuestion(msg, context, tier);
      if (!answer) {
        // No exception, but nothing usable came back either. Not
        // necessarily a size problem — LocalAI now logs the full
        // completion result (stop reason, token counts) when this
        // happens, so check that log rather than assume "too large".
        console.warn('[Chat] answerQuestion returned empty/null response for:', msg);
      }
      setMessages((prev) =>
        prev.filter((m) => m.id !== thinkingMsg.id).concat({
          id: makeId(),
          text: answer || '⚠️ AI response failed — the model returned nothing. Check console logs for [LocalAI] empty completion result, or try again.',
          from: 'ai',
        })
      );
    } catch (err) {
      console.error('[Chat] answerQuestion failed:', err);
      const sizeRelated = /context is full|context window|too large/i.test(err.message || '');
      setMessages((prev) =>
        prev.filter((m) => m.id !== thinkingMsg.id).concat({
          id: makeId(),
          text: '⚠️ ' + (sizeRelated
            ? 'AI response failed — prompt may be too large. Try a simpler question.'
            : (err.message || 'Something went wrong.')),
          from: 'ai',
        })
      );
    } finally {
      setSending(false);
    }
  };

  if (tier === null) return <View style={styles.flex} />;
  if (tier === 'free') return <ChatUpgradePrompt navigation={navigation} />;

  const renderWelcome = () => (
    <View style={styles.welcome}>
      <Text style={styles.welcomeIcon}>🤖</Text>
      <Text style={styles.welcomeTitle}>Your AI Windsurfing Coach</Text>
      <Text style={styles.welcomeSub}>Ask about your sessions, gear or technique</Text>
      <View style={styles.suggestedList}>
        {SUGGESTED_QUESTIONS.map((q) => (
          <TouchableOpacity activeOpacity={0.7} key={q.question} style={styles.suggestedBtn} onPress={() => send(q.question)}>
            <Text style={styles.suggestedText}>{q.emoji} {q.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  const renderItem = ({ item }) => {
    if (item.from === 'thinking') {
      return <View style={[styles.bubble, styles.aiBubble]}><ThinkingDots /></View>;
    }
    if (item.from === 'user') {
      return (
        <View style={[styles.bubble, styles.userBubble]}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
      );
    }
    return (
      <View style={[styles.bubble, styles.aiBubble]}>
        <Markdown style={markdownStyles}>{item.text}</Markdown>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <Header title="💬 Chat" />
      <View style={styles.modelBar}>
        {modelDownloaded ? (
          <View style={styles.modelBadge}>
            <Text style={styles.modelBadgeText}>✅ AI Ready (on-device)</Text>
          </View>
        ) : downloading ? (
          <View style={styles.modelBadge}>
            <Text style={styles.modelBadgeText}>
              Downloading model… {Math.round(downloadProgress * 100)}%
            </Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round(downloadProgress * 100)}%` }]} />
            </View>
          </View>
        ) : (
          <TouchableOpacity activeOpacity={0.7} style={styles.downloadBtn} onPress={handleDownloadModel} accessibilityLabel="Download AI Model">
            <Text style={styles.downloadBtnText}>⬇️ Download AI Model</Text>
            <Text style={styles.downloadBtnSub}>Requires 2.3GB storage</Text>
          </TouchableOpacity>
        )}
      </View>
      <FlatList showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
        ref={listRef}
        data={messages}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        ListEmptyComponent={renderWelcome}
        contentContainerStyle={styles.messagesContent}
        style={styles.messagesList}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />
      <View style={styles.inputRow}>
        <TextInput
          value={input}
          onChangeText={setInput}
          style={styles.input}
          placeholder="Ask about your sessions…"
          placeholderTextColor="rgba(205,232,240,0.3)"
          onSubmitEditing={() => send()}
          returnKeyType="send"
          editable={!sending}
        />
        <TouchableOpacity activeOpacity={0.7} style={[styles.sendBtn, sending && styles.sendBtnDisabled]} onPress={() => send()} disabled={sending}>
          <Text style={styles.sendIcon}>➤</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.deep },
  messagesList: { flex: 1, backgroundColor: colors.deep },
  messagesContent: { padding: 14, flexGrow: 1 },

  modelBar: { paddingHorizontal: 14, paddingTop: 10 },
  modelBadge: {
    backgroundColor: 'rgba(26,138,181,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  modelBadgeText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  progressTrack: {
    height: 4,
    backgroundColor: 'rgba(205,232,240,0.15)',
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  progressFill: { height: 4, backgroundColor: colors.accent, borderRadius: 2 },
  downloadBtn: {
    backgroundColor: 'rgba(26,138,181,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  downloadBtnText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  downloadBtnSub: { color: 'rgba(205,232,240,0.4)', fontSize: 11, marginTop: 2 },

  welcome: { alignItems: 'center', paddingTop: 24, paddingHorizontal: 8 },
  welcomeIcon: { fontSize: 28, marginBottom: 6 },
  welcomeTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  welcomeSub: { color: 'rgba(205,232,240,0.4)', fontSize: 12, marginTop: 6, textAlign: 'center' },
  suggestedList: { width: '100%', marginTop: 16, gap: 7 },
  suggestedBtn: {
    backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
    borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 7,
  },
  suggestedText: { color: colors.text, fontSize: 13 },

  bubble: { maxWidth: '88%', paddingVertical: 11, paddingHorizontal: 13, borderRadius: 16, marginBottom: 10 },
  userBubble: { backgroundColor: colors.accent, alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  aiBubble: {
    backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1, borderColor: 'rgba(26,138,181,0.25)',
    alignSelf: 'flex-start', borderBottomLeftRadius: 4, maxWidth: '93%',
  },
  userText: { color: '#ffffff', fontSize: 14, lineHeight: 21 },
  thinkingText: { color: 'rgba(205,232,240,0.45)', fontSize: 13, fontStyle: 'italic' },

  inputRow: {
    flexDirection: 'row', alignItems: 'center', padding: 10,
    paddingBottom: Platform.OS === 'ios' ? 20 : 12,
    backgroundColor: 'rgba(6,31,46,0.95)', borderTopWidth: 1, borderTopColor: 'rgba(26,138,181,0.25)',
  },
  input: {
    flex: 1, marginRight: 8, backgroundColor: 'rgba(26,138,181,0.1)', borderWidth: 1,
    borderColor: 'rgba(26,138,181,0.25)', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14,
    color: colors.text, fontSize: 15, height: 44,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.5 },
  sendIcon: { color: '#fff', fontSize: 18 },

  upgradeScreen: { flex: 1, backgroundColor: colors.deep },
  upgradeBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  upgradeIcon: { fontSize: 40, marginBottom: 16 },
  upgradeTitle: { color: colors.text, fontSize: 17, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  upgradeSub: { color: 'rgba(205,232,240,0.5)', fontSize: 13, textAlign: 'center', marginBottom: 20 },
  upgradeBtn: { backgroundColor: colors.accent, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

const markdownStyles = {
  body: { color: colors.text, fontSize: 14, lineHeight: 22, backgroundColor: 'transparent' },
  heading1: { color: colors.accent, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  heading2: { color: colors.accent, fontSize: 16, fontWeight: '700', marginTop: 8, marginBottom: 6 },
  heading3: { color: colors.accent, fontSize: 14, fontWeight: '600', marginTop: 6, marginBottom: 4 },
  strong: { color: colors.accent, fontWeight: '700' },
  em: { color: colors.text, fontStyle: 'italic' },
  bullet_list: { marginBottom: 8 },
  ordered_list: { marginBottom: 8 },
  list_item: { color: colors.text, marginBottom: 4 },
  hr: { backgroundColor: 'rgba(26,138,181,0.3)', height: 1, marginVertical: 8 },
  code_inline: { backgroundColor: 'rgba(26,138,181,0.15)', color: colors.text, borderRadius: 4, paddingHorizontal: 4 },
  code_block: { backgroundColor: 'transparent', color: colors.text },
  fence: { backgroundColor: 'transparent', color: colors.text, borderWidth: 0 },
};

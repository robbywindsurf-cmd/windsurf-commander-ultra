// ChatScreen.js — AI coach chat, Premium+ only.
// Adapted from the production app's ChatScreen.js: no Oracle webhook, no
// remote AI. Context (recent sessions, last analysis, weather, equipment)
// is pulled from local SQLite and passed to commander-core's CoachingService
// (a stub AI for now — real inference lands in a later phase).

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useFocusEffect } from '@react-navigation/native';
import {
  TierService, CoachingService,
  SessionRepository, AnalysisRepository, WeatherRepository, EquipmentRepository,
} from '@commandersuite/core';
import Header from '../components/Header';
import { colors } from '../theme';

const SUGGESTED_QUESTIONS = [
  { emoji: '📅', label: 'How was my last session?', question: 'How was my last session?' },
  { emoji: '⚙️', label: 'What gear should I use today?', question: 'What gear should I use today?' },
  { emoji: '🏄', label: 'How can I improve my technique?', question: 'How can I improve my technique?' },
  { emoji: '🏆', label: 'What was my best speed this year?', question: 'What was my best speed this year?' },
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
        <TouchableOpacity style={styles.upgradeBtn} onPress={() => navigation.navigate('Upgrade')}>
          <Text style={styles.upgradeBtnText}>Upgrade</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function ChatScreen({ navigation }) {
  const [tier, setTier] = useState(null); // null = still resolving
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  useFocusEffect(useCallback(() => {
    TierService.getCachedTier().then(setTier);
  }, []));

  useEffect(() => {
    if (messages.length) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages]);

  async function buildContext() {
    const [recentSessions, lastAnalysis, weatherRows, equipment] = await Promise.all([
      SessionRepository.getRecentSessions(3),
      AnalysisRepository.getLatestAnalysis(),
      WeatherRepository.getAllToday(),
      EquipmentRepository.getAll(),
    ]);
    return { recentSessions, lastAnalysis, weather: weatherRows?.[0] || null, equipment };
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
      setMessages((prev) =>
        prev.filter((m) => m.id !== thinkingMsg.id).concat({
          id: makeId(),
          text: answer || "⚠️ Couldn't generate a response.",
          from: 'ai',
        })
      );
    } catch (err) {
      setMessages((prev) =>
        prev.filter((m) => m.id !== thinkingMsg.id).concat({
          id: makeId(), text: '⚠️ ' + (err.message || 'Something went wrong.'), from: 'ai',
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
          <TouchableOpacity key={q.question} style={styles.suggestedBtn} onPress={() => send(q.question)}>
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
      <FlatList
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
        <TouchableOpacity style={[styles.sendBtn, sending && styles.sendBtnDisabled]} onPress={() => send()} disabled={sending}>
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

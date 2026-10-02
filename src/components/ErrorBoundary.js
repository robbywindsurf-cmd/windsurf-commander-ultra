// ErrorBoundary.js — keeps one failing section from taking the whole app down.
//
// A render error inside a component is not caught by try/catch: React unwinds,
// and in a Release build an uncaught JS error goes to RCTExceptionsManager's
// fatal handler, which aborts the process. So a fault in a single card or chart
// kills the app rather than that one view.
//
// The fallback names the error on screen AND traces it, deliberately. Swallowing
// it silently would trade a crash for an invisible feature, and the reason would
// then only exist on a device the developer cannot attach to — which is exactly
// the situation this was written in.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { trace } from '@commandersuite/core';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const where = this.props.label || 'section';
    const stack = (info?.componentStack || '').split('\n').slice(1, 4).map((s) => s.trim()).join(' < ');
    // trace() writes to ai-debug.log, the only channel readable on a Release
    // build — console.* reaches neither Metro nor the device console there.
    trace(`[UI] ${where} threw: ${error?.message} || ${stack}`);
    console.warn(`[UI] ${where} threw:`, error?.message);
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.box}>
          <Text style={styles.title}>
            ⚠️ {this.props.label || 'This section'} couldn't be shown
          </Text>
          <Text style={styles.detail}>{String(this.state.error?.message || this.state.error)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1, borderColor: 'rgba(248,113,113,0.5)', backgroundColor: 'rgba(248,113,113,0.08)',
    borderRadius: 10, padding: 12, marginVertical: 8,
  },
  title: { color: '#fca5a5', fontSize: 12, fontWeight: '700', marginBottom: 4 },
  detail: { color: 'rgba(205,232,240,0.7)', fontSize: 11, lineHeight: 16 },
});

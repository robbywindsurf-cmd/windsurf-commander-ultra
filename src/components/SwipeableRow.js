import React, { useRef } from 'react';
import { Animated, PanResponder, View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { colors } from '../theme';

const DELETE_WIDTH = 88;

// Dependency-free swipe-to-delete (react-native-gesture-handler isn't
// installed and would need a native rebuild) — plain PanResponder + Animated,
// revealing a Delete button that confirms before calling onDelete.
export default function SwipeableRow({ children, onDelete, confirmTitle = 'Delete?', confirmMessage = 'This cannot be undone.' }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const openRef = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_, gesture) => {
        const base = openRef.current ? -DELETE_WIDTH : 0;
        const next = Math.min(0, Math.max(-DELETE_WIDTH, base + gesture.dx));
        translateX.setValue(next);
      },
      onPanResponderRelease: (_, gesture) => {
        const base = openRef.current ? -DELETE_WIDTH : 0;
        const finalX = Math.min(0, Math.max(-DELETE_WIDTH, base + gesture.dx));
        const shouldOpen = finalX < -DELETE_WIDTH / 2;
        openRef.current = shouldOpen;
        Animated.spring(translateX, { toValue: shouldOpen ? -DELETE_WIDTH : 0, useNativeDriver: true }).start();
      },
    })
  ).current;

  function resetRow() {
    openRef.current = false;
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
  }

  function confirmDelete() {
    Alert.alert(confirmTitle, confirmMessage, [
      { text: 'Cancel', style: 'cancel', onPress: resetRow },
      { text: 'Delete', style: 'destructive', onPress: () => { resetRow(); onDelete(); } },
    ]);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.deleteUnderlay}>
        <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete}>
          <Text style={styles.deleteBtnText}>Delete</Text>
        </TouchableOpacity>
      </View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', marginBottom: 12, borderRadius: 12, overflow: 'hidden' },
  deleteUnderlay: {
    position: 'absolute', top: 0, right: 0, bottom: 0, width: DELETE_WIDTH,
    backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center',
  },
  deleteBtn: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  deleteBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});

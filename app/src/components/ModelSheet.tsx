// Bottom sheet for the composer's model control, official-app style: the model list from
// the live /api/models feed plus a separate "Extended thinking" toggle. Hand-rolled with
// core Animated + Modal (same pattern as Sidebar).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../state/ThemeContext';
import { radius, spacing, type Colors } from '../theme';
import type { ModelOption } from '../api';

const SLIDE_MS = 200;

export function ModelSheet({
  visible,
  models,
  selectedId,
  thinking,
  onSelect,
  onThinkingChange,
  onClose,
}: {
  visible: boolean;
  models: ModelOption[];
  selectedId: string;
  thinking: boolean;
  onSelect: (id: string) => void;
  onThinkingChange: (on: boolean) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [mounted, setMounted] = useState(visible);
  const slide = useRef(new Animated.Value(400)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(slide, {
          toValue: 0,
          duration: SLIDE_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, { toValue: 1, duration: SLIDE_MS, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slide, {
          toValue: 400,
          duration: SLIDE_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, { toValue: 0, duration: SLIDE_MS, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, slide, backdrop]);

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={styles.flex} onPress={onClose} />
        </Animated.View>

        <Animated.View style={[styles.sheet, { transform: [{ translateY: slide }] }]}>
          <SafeAreaView edges={['bottom']}>
            <View style={styles.grabber} />
            <Text style={styles.title}>Model</Text>
            <ScrollView style={styles.list} bounces={false}>
              {models.map((m) => {
                const active = m.id === selectedId;
                return (
                  <Pressable
                    key={m.id}
                    style={styles.row}
                    onPress={() => {
                      onSelect(m.id);
                      onClose();
                    }}
                  >
                    <Text style={[styles.rowText, active && styles.rowTextActive]} numberOfLines={1}>
                      {m.label}
                    </Text>
                    {active ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.thinkingRow}>
              <View style={styles.flex}>
                <Text style={styles.thinkingLabel}>Extended thinking</Text>
                <Text style={styles.thinkingHint}>
                  Let Claude reason longer before answering. Slower, better on hard problems.
                </Text>
              </View>
              <Switch
                value={thinking}
                onValueChange={onThinkingChange}
                trackColor={{ true: colors.accent }}
              />
            </View>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: radius.pill,
      backgroundColor: c.border,
      marginBottom: spacing.sm,
    },
    title: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.xs,
    },
    list: { maxHeight: 320 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowText: { color: c.text, fontSize: 15, flex: 1 },
    rowTextActive: { color: c.textStrong, fontWeight: '700' },
    check: { color: c.accent, fontSize: 15, fontWeight: '700', marginLeft: spacing.sm },
    thinkingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.md,
    },
    thinkingLabel: { color: c.textStrong, fontSize: 15, fontWeight: '600' },
    thinkingHint: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  });

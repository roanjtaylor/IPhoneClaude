// The bottom input bar, official-app style: one rounded container holding the text field
// on top and a controls row below — attach (+) on the left, the model pill and coral
// send/stop button on the right. Also hosts pending-attachment previews and the
// "editing a sent message" state (pre-filled text + a cancellable chip).
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../state/ThemeContext';
import { radius, spacing, type Colors } from '../theme';
import type { Attachment } from '../storage/types';
import { deleteAttachment } from '../storage/attachments';
import { pickDocument, pickImageFromLibrary, takePhoto } from '../lib/pickAttachment';

const MAX_ATTACHMENTS = 4;

export type ComposerHandle = {
  /** Enter edit mode: pre-fill the field with a sent message's text and focus it. */
  startEditing: (messageId: string, text: string) => void;
};

export const Composer = forwardRef<
  ComposerHandle,
  {
    busy: boolean;
    /** Short display name of the current model, shown on the model pill. */
    modelLabel: string;
    /** Extended thinking is on — the pill shows a small indicator. */
    thinking: boolean;
    incognito?: boolean;
    onSend: (args: { text: string; attachments: Attachment[] }) => void;
    onStop: () => void;
    onOpenModelSheet: () => void;
    /** Commit an edit of a previously sent message (edit mode replaces onSend). */
    onEditSubmit: (messageId: string, text: string) => void;
  }
>(function Composer(
  { busy, modelLabel, thinking, incognito, onSend, onStop, onOpenModelSheet, onEditSubmit },
  ref,
) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  // Stash the drafted text while editing so cancelling restores it.
  const draftRef = useRef('');
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useImperativeHandle(ref, () => ({
    startEditing: (messageId, text) => {
      draftRef.current = input;
      setEditingId(messageId);
      setInput(text);
      inputRef.current?.focus();
    },
  }));

  // Leaving the chat while editing (session switch) is handled by the parent unmounting
  // or resetting us via key; busy just disables submission.
  useEffect(() => {
    if (busy && editingId) setEditingId(null);
  }, [busy, editingId]);

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !busy;

  const addAttachment = async (pick: () => Promise<Attachment | null>) => {
    if (attachments.length >= MAX_ATTACHMENTS) {
      Alert.alert('Limit reached', `Up to ${MAX_ATTACHMENTS} attachments per message.`);
      return;
    }
    setPicking(true);
    try {
      const att = await pick();
      if (att) setAttachments((prev) => [...prev, att]);
    } catch {
      Alert.alert('Could not attach', 'Something went wrong picking that file.');
    } finally {
      setPicking(false);
    }
  };

  const onAttachPress = () => {
    Alert.alert('Add attachment', undefined, [
      { text: 'Photo Library', onPress: () => addAttachment(pickImageFromLibrary) },
      { text: 'Take Photo', onPress: () => addAttachment(takePhoto) },
      { text: 'Document', onPress: () => addAttachment(pickDocument) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const removeAttachment = async (att: Attachment) => {
    setAttachments((prev) => prev.filter((a) => a.id !== att.id));
    await deleteAttachment(att.uri).catch(() => {});
  };

  const cancelEditing = () => {
    setEditingId(null);
    setInput(draftRef.current);
    draftRef.current = '';
  };

  const send = () => {
    if (!canSend) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (editingId) {
      const id = editingId;
      const text = input.trim();
      setEditingId(null);
      setInput(draftRef.current);
      draftRef.current = '';
      onEditSubmit(id, text);
      return;
    }
    onSend({ text: input.trim(), attachments });
    setInput('');
    setAttachments([]);
  };

  return (
    <View style={styles.container}>
      {editingId ? (
        <View style={styles.editingChip}>
          <Text style={styles.editingText}>Editing message — later replies will be replaced</Text>
          <Pressable onPress={cancelEditing} hitSlop={8}>
            <Text style={styles.editingCancel}>×</Text>
          </Pressable>
        </View>
      ) : null}

      {attachments.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pending}>
          {attachments.map((a) => (
            <Pressable key={a.id} onPress={() => removeAttachment(a)} style={styles.pendingItem}>
              {a.type === 'image' ? (
                <Image source={{ uri: a.uri }} style={styles.pendingThumb} />
              ) : (
                <View style={[styles.pendingThumb, styles.pendingDoc]}>
                  <Text style={styles.pendingDocText} numberOfLines={2}>
                    📄 {a.name}
                  </Text>
                </View>
              )}
              <View style={styles.removeBadge}>
                <Text style={styles.removeBadgeText}>×</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.field, incognito && styles.fieldIncognito]}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={incognito ? 'Incognito message…' : 'Message Claude…'}
          placeholderTextColor={colors.textMuted}
          multiline
          editable={!busy}
        />

        <View style={styles.controls}>
          <Pressable
            style={styles.attach}
            onPress={onAttachPress}
            disabled={busy || picking}
            hitSlop={8}
          >
            {picking ? (
              <ActivityIndicator color={colors.textMuted} size="small" />
            ) : (
              <Text style={styles.attachText}>＋</Text>
            )}
          </Pressable>

          <View style={styles.spacer} />

          <Pressable style={styles.modelPill} onPress={onOpenModelSheet} hitSlop={6}>
            <Text style={styles.modelPillText} numberOfLines={1}>
              {modelLabel}
              {thinking ? ' ✦' : ''}
            </Text>
            <Text style={styles.modelPillChevron}>▾</Text>
          </Pressable>

          {busy ? (
            <Pressable style={styles.stop} onPress={onStop}>
              <View style={styles.stopSquare} />
            </Pressable>
          ) : (
            <Pressable
              style={[styles.send, !canSend && styles.sendDisabled]}
              onPress={send}
              disabled={!canSend}
            >
              <Text style={styles.sendText}>↑</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
});

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {
      backgroundColor: c.bg,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.xs,
      paddingBottom: spacing.sm,
    },
    editingChip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginBottom: spacing.xs,
    },
    editingText: { color: c.textMuted, fontSize: 12, flex: 1 },
    editingCancel: { color: c.textStrong, fontSize: 18, marginLeft: spacing.sm, marginTop: -2 },
    pending: { paddingBottom: spacing.sm },
    pendingItem: { marginRight: spacing.sm },
    pendingThumb: { width: 56, height: 56, borderRadius: radius.md, backgroundColor: c.surfaceAlt },
    pendingDoc: { alignItems: 'center', justifyContent: 'center', padding: 4 },
    pendingDocText: { color: c.text, fontSize: 9, textAlign: 'center' },
    removeBadge: {
      position: 'absolute',
      top: -6,
      right: -6,
      backgroundColor: '#000',
      borderRadius: 10,
      width: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    removeBadgeText: { color: '#fff', fontSize: 14, lineHeight: 16 },
    field: {
      backgroundColor: c.surface,
      borderRadius: radius.input,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.hairline,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.xs,
      paddingBottom: spacing.xs,
    },
    fieldIncognito: {
      borderWidth: 1,
      borderColor: c.textMuted,
      borderStyle: 'dashed',
    },
    input: {
      maxHeight: 120,
      minHeight: 38,
      paddingHorizontal: spacing.sm,
      paddingTop: 9,
      paddingBottom: 5,
      color: c.textStrong,
      fontSize: 16,
    },
    controls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    attach: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachText: { color: c.text, fontSize: 24, marginTop: -2 },
    spacer: { flex: 1 },
    modelPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      maxWidth: 170,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    modelPillText: { color: c.textMuted, fontSize: 13, fontWeight: '600', flexShrink: 1 },
    modelPillChevron: { color: c.textMuted, fontSize: 11 },
    send: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendDisabled: { opacity: 0.4 },
    sendText: { color: c.textOnAccent, fontSize: 18, fontWeight: '700', marginTop: -1 },
    stop: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: c.accent },
  });

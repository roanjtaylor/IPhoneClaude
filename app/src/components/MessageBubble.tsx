// One chat message. User turns render as plain text in an accent bubble (long-press to
// edit & resend); assistant turns render rich Markdown, live while streaming — useChat
// throttles flushes to ~4 fps, which the iPhone 7 handles. Two escape hatches guard the
// old phone: PLAIN_WHILE_STREAMING reverts to the cheap plain-text streaming render, and
// very long replies fall back to plain text until complete. Shows attachments, sources,
// timestamp, and (for the latest assistant turn) copy/share/regenerate actions.
import { memo, useMemo } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../state/ThemeContext';
import type { RootStackParamList } from '../navigation/types';
import { radius, spacing, type Colors } from '../theme';
import type { Message } from '../storage/types';
import { MarkdownMessage } from './MarkdownMessage';
import { SourcesList } from './SourcesList';
import { MessageActions } from './MessageActions';

// Set to true to restore the pre-live-markdown behaviour if streaming ever stutters.
const PLAIN_WHILE_STREAMING = false;
// Beyond this many characters, the streaming bubble renders plain text (markdown parse
// cost grows with length); it still upgrades to full Markdown on completion.
const STREAM_MARKDOWN_LIMIT = 15000;

function formatTime(ts: number): string {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function AttachmentPreviews({ message, styles }: { message: Message; styles: Styles }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const atts = message.attachments ?? [];
  if (atts.length === 0) return null;
  return (
    <View style={styles.atts}>
      {atts.map((a) =>
        a.type === 'image' ? (
          <Pressable
            key={a.id}
            onPress={() => navigation.navigate('ImageViewer', { uri: a.uri })}
          >
            <Image source={{ uri: a.uri }} style={styles.thumb} resizeMode="cover" />
          </Pressable>
        ) : (
          <View key={a.id} style={styles.fileChip}>
            <Text style={styles.fileChipText} numberOfLines={1}>
              📄 {a.name}
            </Text>
          </View>
        ),
      )}
    </View>
  );
}

function MessageBubbleImpl({
  message,
  busy,
  wide,
  isLastAssistant,
  onRegenerate,
  onContinue,
  onEditRequest,
}: {
  message: Message;
  busy: boolean;
  /** "Fit Width" mode: let bubbles use the full screen width (more text per line). */
  wide?: boolean;
  isLastAssistant: boolean;
  onRegenerate?: () => void;
  onContinue?: () => void;
  /** User messages only: long-press → edit & resend from this point. */
  onEditRequest?: (message: Message) => void;
}) {
  const isUser = message.role === 'user';
  const streaming = message.status === 'streaming';
  const stopped = message.status === 'stopped';
  const empty = message.content.length === 0;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // Long-press a sent user message → Edit (regenerate from that point) or Copy.
  const onUserLongPress = () => {
    const actions: Parameters<typeof Alert.alert>[2] = [
      {
        text: 'Copy',
        onPress: () => {
          void Clipboard.setStringAsync(message.content);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ];
    if (onEditRequest) {
      actions.unshift({ text: 'Edit & resend', onPress: () => onEditRequest(message) });
    }
    Alert.alert('Message', undefined, actions);
  };

  const streamAsPlain =
    PLAIN_WHILE_STREAMING || message.content.length > STREAM_MARKDOWN_LIMIT;

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <Pressable
        style={[
          styles.bubble,
          wide && styles.bubbleWide,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
        ]}
        onLongPress={isUser ? onUserLongPress : undefined}
        disabled={!isUser}
      >
        <AttachmentPreviews message={message} styles={styles} />
        {empty && busy ? (
          <ActivityIndicator color={colors.textMuted} size="small" />
        ) : isUser ? (
          message.content.length > 0 ? (
            <Text style={styles.userText}>{message.content}</Text>
          ) : null
        ) : streaming && streamAsPlain ? (
          // Escape hatch: plain text while tokens stream; upgrades to Markdown when done.
          <Text style={styles.assistantText}>{message.content}</Text>
        ) : (
          // Live Markdown — useChat throttles content flushes so this re-parses ~4×/s max.
          <MarkdownMessage content={message.content} sources={message.sources} />
        )}

        {message.sources && message.sources.length > 0 ? (
          <SourcesList sources={message.sources} />
        ) : null}
      </Pressable>

      {!isUser && !streaming && message.content.length > 0 ? (
        <View style={styles.metaRow}>
          <View style={styles.metaTopRow}>
            <Text style={styles.time}>{formatTime(message.createdAt)}</Text>
            {stopped ? <Text style={styles.stoppedTag}>· Stopped</Text> : null}
          </View>
          <MessageActions
            content={message.content}
            canRegenerate={isLastAssistant && !busy}
            onRegenerate={onRegenerate}
            stopped={stopped}
            onContinue={onContinue}
          />
        </View>
      ) : null}
    </View>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    row: { marginVertical: 4 },
    rowUser: { alignItems: 'flex-end' },
    rowAssistant: { alignItems: 'flex-start' },
    bubble: { maxWidth: '88%', borderRadius: radius.bubble, paddingHorizontal: 14, paddingVertical: 10 },
    bubbleWide: { maxWidth: '100%' },
    bubbleUser: { backgroundColor: c.accent },
    // Official look: assistant turns sit flat on the canvas, full width — no card. This
    // also gives wide tables/code blocks the whole screen.
    bubbleAssistant: {
      backgroundColor: 'transparent',
      maxWidth: '100%',
      alignSelf: 'stretch',
      paddingHorizontal: 2,
    },
    userText: { color: c.textOnAccent, fontSize: 16, lineHeight: 22 },
    assistantText: { color: c.text, fontSize: 16, lineHeight: 22 },
    metaRow: { marginTop: 2, paddingHorizontal: 2 },
    metaTopRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    time: { color: c.textFaint, fontSize: 11, marginTop: spacing.xs },
    stoppedTag: { color: c.accent, fontSize: 11, marginTop: spacing.xs, fontWeight: '600' },
    atts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.xs },
    thumb: { width: 120, height: 120, borderRadius: radius.card, backgroundColor: c.surfaceAlt },
    fileChip: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.card,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      maxWidth: 200,
    },
    fileChipText: { color: c.text, fontSize: 13 },
  });

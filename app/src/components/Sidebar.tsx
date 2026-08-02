// Slide-out sidebar (official-app style): new chat, search, recent chats, Projects,
// full history, and Settings. Hand-rolled with core Animated + Modal — no reanimated /
// gesture-handler, which keeps it dependable on iOS 15 / iPhone 7.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../state/ThemeContext';
import { radius, spacing, type Colors } from '../theme';
import {
  listConversations,
  searchConversations,
  type ConversationSearchHit,
} from '../storage/db';
import type { Conversation } from '../storage/types';
import { ClaudeMascot } from './ClaudeMascot';

const PANEL_WIDTH = Math.min(Math.round(Dimensions.get('window').width * 0.84), 340);
const SLIDE_MS = 220;
const RECENT_LIMIT = 30;

export function Sidebar({
  visible,
  activeConversationId,
  onClose,
  onSelectConversation,
  onNewChat,
  onOpenProjects,
  onOpenHistory,
  onOpenSettings,
}: {
  visible: boolean;
  activeConversationId?: string;
  onClose: () => void;
  onSelectConversation: (conv: Conversation) => void;
  onNewChat: () => void;
  onOpenProjects: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // `mounted` keeps the Modal alive during the slide-out animation.
  const [mounted, setMounted] = useState(visible);
  const slide = useRef(new Animated.Value(-PANEL_WIDTH)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSearchHit[]>([]);
  const searchingList = query.trim().length > 0;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setQuery('');
      void listConversations().then((list) => setConversations(list.slice(0, RECENT_LIMIT)));
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
          toValue: -PANEL_WIDTH,
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

  // Debounced full-text search over titles + message content (reuses the db helper).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      searchConversations(q).then((hits) => {
        if (alive) setResults(hits);
      });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const rows: ConversationSearchHit[] = searchingList
    ? results
    : conversations.map((conversation) => ({ conversation }));

  const renderRow = useCallback(
    ({ item }: { item: ConversationSearchHit }) => {
      const conv = item.conversation;
      const active = conv.id === activeConversationId;
      return (
        <Pressable
          style={[styles.chatRow, active && styles.chatRowActive]}
          onPress={() => onSelectConversation(conv)}
        >
          <Text
            style={[styles.chatTitle, active && styles.chatTitleActive]}
            numberOfLines={1}
          >
            {conv.title}
          </Text>
          {item.snippet ? (
            <Text style={styles.chatSnippet} numberOfLines={1}>
              {item.snippet}
            </Text>
          ) : null}
        </Pressable>
      );
    },
    [styles, activeConversationId, onSelectConversation],
  );

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={styles.flex} onPress={onClose} />
        </Animated.View>

        <Animated.View style={[styles.panel, { transform: [{ translateX: slide }] }]}>
          <SafeAreaView style={styles.flex} edges={['top', 'bottom', 'left']}>
            <View style={styles.brandRow}>
              <ClaudeMascot size={22} color={colors.accent} />
              <Text style={styles.brand}>Claude</Text>
            </View>

            <Pressable style={styles.newChat} onPress={onNewChat}>
              <Text style={styles.newChatPlus}>＋</Text>
              <Text style={styles.newChatText}>New chat</Text>
            </Pressable>

            <TextInput
              style={styles.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Search chats…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
            />

            <Pressable style={styles.navRow} onPress={onOpenProjects}>
              <Text style={styles.navText}>Projects</Text>
            </Pressable>

            <Text style={styles.sectionLabel}>{searchingList ? 'Results' : 'Recents'}</Text>
            <FlatList
              data={rows}
              keyExtractor={(h) => h.conversation.id}
              renderItem={renderRow}
              style={styles.flex}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  {searchingList ? `No chats match “${query.trim()}”.` : 'No chats yet.'}
                </Text>
              }
            />

            <Pressable style={styles.navRow} onPress={onOpenHistory}>
              <Text style={styles.navText}>All chats</Text>
            </Pressable>
            <Pressable style={[styles.navRow, styles.settingsRow]} onPress={onOpenSettings}>
              <Text style={styles.navText}>Settings</Text>
            </Pressable>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    overlay: { flex: 1, flexDirection: 'row' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
    panel: {
      width: PANEL_WIDTH,
      backgroundColor: c.surface,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: c.hairline,
    },
    brandRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    brand: { color: c.textStrong, fontSize: 20, fontWeight: '700' },
    newChat: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.md,
      marginVertical: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderRadius: radius.lg,
      backgroundColor: c.accent,
    },
    newChatPlus: { color: c.textOnAccent, fontSize: 18, fontWeight: '700', marginTop: -1 },
    newChatText: { color: c.textOnAccent, fontSize: 15, fontWeight: '700' },
    search: {
      marginHorizontal: spacing.md,
      marginVertical: spacing.xs,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: c.textStrong,
      fontSize: 15,
    },
    navRow: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    navText: { color: c.text, fontSize: 15, fontWeight: '600' },
    settingsRow: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    sectionLabel: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
    },
    chatRow: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
      borderRadius: radius.md,
      marginHorizontal: spacing.xs,
    },
    chatRowActive: { backgroundColor: c.surfaceAlt },
    chatTitle: { color: c.text, fontSize: 15 },
    chatTitleActive: { color: c.textStrong, fontWeight: '600' },
    chatSnippet: { color: c.textMuted, fontSize: 12, marginTop: 1 },
    emptyText: { color: c.textFaint, fontSize: 14, padding: spacing.lg },
  });

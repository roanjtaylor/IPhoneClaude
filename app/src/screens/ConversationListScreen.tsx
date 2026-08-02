// "All chats" history screen, reached from the sidebar: every saved conversation
// (newest first) with search. Header "Edit" toggles an edit mode where each row can be
// renamed (tap) or deleted (🗑). Tapping a row returns to the Chat screen with that
// conversation loaded.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useConversations } from '../hooks/useConversations';
import { useSettings } from '../state/SettingsContext';
import { useTheme } from '../state/ThemeContext';
import { pingHealth } from '../api';
import { searchConversations, type ConversationSearchHit } from '../storage/db';
import { ClaudeMascot } from '../components/ClaudeMascot';
import { radius, spacing, type Colors } from '../theme';
import type { Conversation } from '../storage/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ConversationList'>;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function ConversationListScreen({ navigation }: Props) {
  const { conversations, loading, refresh, rename, remove } = useConversations();
  const { settings } = useSettings();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSearchHit[]>([]);
  const [editing, setEditing] = useState(false);
  const searching = query.trim().length > 0;

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
  }, [query, conversations]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      void pingHealth({ serverUrl: settings.serverUrl });
    }, [refresh, settings.serverUrl]),
  );

  // The Chat screen creates the SQLite row lazily on first send — just navigate back to
  // it in its fresh "new chat" state.
  const newChat = useCallback(() => {
    navigation.navigate('Chat', { sessionKey: Date.now() });
  }, [navigation]);

  const promptRename = useCallback(
    (conv: Conversation) =>
      Alert.prompt?.(
        'Rename chat',
        undefined,
        (text) => {
          if (text?.trim()) void rename(conv.id, text.trim());
        },
        'plain-text',
        conv.title,
      ),
    [rename],
  );

  const confirmDelete = useCallback(
    (conv: Conversation) =>
      Alert.alert('Delete chat?', `“${conv.title}” will be permanently deleted.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void remove(conv.id) },
      ]),
    [remove],
  );

  // Header: Edit/Done toggle (right). Editing is disabled while there are no chats to
  // act on. (Settings/Projects moved to the sidebar on the Chat screen.)
  useFocusEffect(
    useCallback(() => {
      navigation.setOptions({
        headerRight: () =>
          conversations.length > 0 ? (
            <TouchableOpacity onPress={() => setEditing((e) => !e)} hitSlop={10}>
              <Text style={styles.headerBtn}>{editing ? 'Done' : 'Edit'}</Text>
            </TouchableOpacity>
          ) : null,
      });
    }, [navigation, editing, conversations.length, styles]),
  );

  // Leaving edit mode automatically once the list is empty keeps the header sane.
  useEffect(() => {
    if (conversations.length === 0 && editing) setEditing(false);
  }, [conversations.length, editing]);

  const data: ConversationSearchHit[] = searching
    ? results
    : conversations.map((conversation) => ({ conversation }));

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right', 'bottom']}>
      <View style={styles.searchWrap}>
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
      </View>

      <FlatList
        data={data}
        keyExtractor={(h) => h.conversation.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={data.length === 0 ? styles.emptyWrap : styles.list}
        renderItem={({ item }) => {
          const conv = item.conversation;
          return (
            <View style={styles.row}>
              <Pressable
                style={styles.rowMain}
                onPress={() =>
                  editing
                    ? promptRename(conv)
                    : navigation.navigate('Chat', { conversationId: conv.id, title: conv.title })
                }
                onLongPress={() => promptRename(conv)}
              >
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {conv.title}
                </Text>
                {item.snippet ? (
                  <Text style={styles.rowSnippet} numberOfLines={1}>
                    {item.snippet}
                  </Text>
                ) : null}
                <Text style={styles.rowTime}>{relativeTime(conv.updatedAt)}</Text>
              </Pressable>
              {editing ? (
                <Pressable
                  style={styles.deleteBtn}
                  onPress={() => confirmDelete(conv)}
                  hitSlop={8}
                >
                  <Text style={styles.deleteIcon}>🗑</Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          searching ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No chats match “{query.trim()}”.</Text>
            </View>
          ) : loading ? null : (
            <View style={styles.empty}>
              <ClaudeMascot size={96} color={colors.accent} />
              <Text style={styles.emptyText}>No chats yet.</Text>
              <Pressable style={styles.cta} onPress={newChat}>
                <Text style={styles.ctaText}>Start a new chat</Text>
              </Pressable>
            </View>
          )
        }
      />

      {/* Floating new-chat button. */}
      <TouchableOpacity style={styles.fab} onPress={newChat} activeOpacity={0.85}>
        <Text style={styles.fabPlus}>＋</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    searchWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs },
    search: {
      backgroundColor: c.surface,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      color: c.textStrong,
      fontSize: 15,
    },
    list: { padding: spacing.md, paddingBottom: 96 },
    emptyWrap: { flex: 1 },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    headerBtn: { color: c.accent, fontSize: 16, fontWeight: '600', paddingHorizontal: 4 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderRadius: radius.card,
      marginBottom: spacing.sm,
    },
    rowMain: { flex: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    rowTitle: { color: c.textStrong, fontSize: 16, fontWeight: '600' },
    rowSnippet: { color: c.textMuted, fontSize: 13, marginTop: 2 },
    rowTime: { color: c.textFaint, fontSize: 12, marginTop: 4 },
    deleteBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, alignSelf: 'stretch', justifyContent: 'center' },
    deleteIcon: { fontSize: 18 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.lg },
    emptyText: { color: c.textFaint, fontSize: 15, textAlign: 'center' },
    cta: {
      backgroundColor: c.accent,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    ctaText: { color: c.textOnAccent, fontSize: 15, fontWeight: '600' },
    fab: {
      position: 'absolute',
      right: spacing.lg,
      bottom: spacing.lg,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
      elevation: 5,
    },
    fabPlus: { color: '#ffffff', fontSize: 32, fontWeight: '600', marginTop: -3 },
  });

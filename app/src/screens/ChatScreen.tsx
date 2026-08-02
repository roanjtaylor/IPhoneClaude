// The home screen, official-app style: a chat. With no conversationId it's the "new
// chat" state (centered greeting; the SQLite row is created lazily on first send). The
// hamburger opens the slide-out Sidebar; the composer hosts the model pill + thinking
// toggle; a ghost toggle on an empty chat starts an incognito session that never touches
// storage. Wires useChat to the message list + composer, shows waking/searching banners,
// resolves per-chat config overrides, and fires a keep-warm ping.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useChat } from '../hooks/useChat';
import { useSettings } from '../state/SettingsContext';
import { useTheme } from '../state/ThemeContext';
import { getConversation, getProject, renameConversation, updateConversationModel } from '../storage/db';
import type { Conversation, Message } from '../storage/types';
import { fetchModels, pingHealth, type ApiConfig, type ModelOption } from '../api';
import { MODEL_OPTIONS } from '../config';
import { MessageBubble } from '../components/MessageBubble';
import { Composer, type ComposerHandle } from '../components/Composer';
import { ModelSheet } from '../components/ModelSheet';
import { Sidebar } from '../components/Sidebar';
import { GreetingHeader } from '../components/GreetingHeader';
import { StatusBanner } from '../components/WakingBanner';
import { shareConversation } from '../lib/exportConversation';
import { spacing, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

const FALLBACK_MODELS: ModelOption[] = MODEL_OPTIONS.map((m) => ({ id: m.value, label: m.label }));

/** "Claude Opus 4.8" → "Opus 4.8" for the compact composer pill. */
function shortModelLabel(label: string): string {
  return label.replace(/^Claude\s+/i, '');
}

export function ChatScreen({ route, navigation }: Props) {
  const { conversationId, incognito = false, sessionKey = 0 } = route.params ?? {};
  const { settings, update: updateSettings } = useSettings();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const headerHeight = useHeaderHeight();

  // Identity of the chat session; changing it resets useChat (see the hook).
  const chatKey = conversationId ?? `local:${incognito ? 'incog' : 'new'}:${sessionKey}`;

  const [convOverrides, setConvOverrides] = useState<{
    model?: string;
    systemPrompt?: string;
    projectContext?: string;
  }>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);

  const listRef = useRef<ScrollView>(null);
  const composerRef = useRef<ComposerHandle>(null);
  // Latest messages for the header menu, without re-registering the header each flush.
  const messagesRef = useRef<Message[]>([]);
  // Track scroll Y so "Fit Width" can restore position instead of jumping to end.
  const scrollYRef = useRef(0);
  // Set to true just before a fit-width toggle; cleared in onContentSizeChange.
  const fitChangingRef = useRef(false);
  // Current iOS pinch-zoom scale, updated from onScroll events (zoomScale is iOS-only).
  const zoomScaleRef = useRef(1);

  // "Fit Width": null = default (padded) layout. A number = the content column width in
  // layout points, computed as screenWidth / zoomScale so the column fills the actual
  // visible area at whatever zoom the user has set — same font size, more text per line.
  const [fittedWidth, setFittedWidth] = useState<number | null>(null);
  const wide = fittedWidth !== null;

  const currentModel = convOverrides.model || settings.model;

  // Resolve config: per-chat override → global settings.
  const config: ApiConfig = {
    serverUrl: settings.serverUrl,
    appSharedSecret: settings.appSharedSecret,
    model: currentModel,
    systemPrompt: convOverrides.systemPrompt || settings.systemPrompt,
    projectContext: convOverrides.projectContext,
    thinking: settings.thinking,
  };

  const onTitle = useCallback((title: string) => navigation.setParams({ title }), [navigation]);

  // A lazily-created conversation pins its id into the route so the header menu, model
  // override writes, and sidebar highlighting all see it. useChat skips the reset for
  // this same-id param change.
  const onConversationCreated = useCallback(
    (conv: Conversation) => navigation.setParams({ conversationId: conv.id, title: conv.title }),
    [navigation],
  );

  const {
    messages,
    busy,
    error,
    waking,
    searching,
    send,
    stop,
    regenerate,
    continueReply,
    editAndResend,
  } = useChat(chatKey, conversationId, config, onTitle, {
    ephemeral: incognito,
    onConversationCreated,
  });

  // Load per-chat overrides + header title for a persisted conversation; warm the server.
  useEffect(() => {
    setConvOverrides({});
    if (conversationId) {
      getConversation(conversationId).then(async (c) => {
        if (c) {
          // A chat in a project inherits the project's standing context.
          const project = c.projectId ? await getProject(c.projectId) : null;
          setConvOverrides({
            model: c.model,
            systemPrompt: c.systemPrompt,
            projectContext: project?.contextPrompt || undefined,
          });
          if (!route.params?.title) navigation.setParams({ title: c.title });
        }
      });
    }
    void pingHealth({ serverUrl: settings.serverUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Pull the live model list so new releases appear without an app update.
  useEffect(() => {
    let alive = true;
    fetchModels({ serverUrl: settings.serverUrl, appSharedSecret: settings.appSharedSecret }).then(
      (list) => {
        if (alive && list) setModels(list);
      },
    );
    return () => {
      alive = false;
    };
  }, [settings.serverUrl, settings.appSharedSecret]);

  const modelLabel = useMemo(() => {
    const found = models.find((m) => m.id === currentModel);
    return shortModelLabel(found?.label ?? currentModel);
  }, [models, currentModel]);

  // Keep the current selection visible in the sheet even if the live list omits it.
  const sheetModels = useMemo(
    () =>
      models.some((m) => m.id === currentModel)
        ? models
        : [...models, { id: currentModel, label: currentModel }],
    [models, currentModel],
  );

  // Model choice applies to this chat (override) and becomes the default for new chats.
  const selectModel = useCallback(
    (id: string) => {
      setConvOverrides((prev) => ({ ...prev, model: id }));
      if (conversationId && !incognito) void updateConversationModel(conversationId, id);
      void updateSettings({ model: id });
    },
    [conversationId, incognito, updateSettings],
  );

  const setThinking = useCallback(
    (on: boolean) => void updateSettings({ thinking: on }),
    [updateSettings],
  );

  // ---- Sidebar navigation ----------------------------------------------------

  const openConversation = useCallback(
    (conv: Conversation) => {
      setSidebarOpen(false);
      stop();
      navigation.setParams({
        conversationId: conv.id,
        title: conv.title,
        incognito: false,
        sessionKey: undefined,
      });
    },
    [navigation, stop],
  );

  const startNewChat = useCallback(
    (nextIncognito: boolean) => {
      setSidebarOpen(false);
      stop();
      navigation.setParams({
        conversationId: undefined,
        title: undefined,
        incognito: nextIncognito,
        sessionKey: Date.now(),
      });
    },
    [navigation, stop],
  );

  // ---- Header ----------------------------------------------------------------

  // Tap the header title to rename a saved chat in place.
  const promptRename = useCallback(() => {
    if (!conversationId) return;
    const current = route.params?.title ?? 'Chat';
    Alert.prompt?.(
      'Rename chat',
      undefined,
      (text) => {
        const name = text?.trim();
        if (!name) return;
        navigation.setParams({ title: name });
        void renameConversation(conversationId, name);
      },
      'plain-text',
      current,
    );
  }, [navigation, route.params?.title, conversationId]);

  // "Fit Width": expand the content column to fill the visible area at the current zoom.
  // screenWidth / zoomScale gives the layout-point width that, when rendered at zoomScale,
  // exactly fills the screen — more text per line without changing font size.
  // fitChangingRef prevents onContentSizeChange from jumping to end during the reflow
  // (scrollToEnd doesn't account for native zoom scale → overshoots → blank screen).
  const toggleFit = useCallback(() => {
    fitChangingRef.current = true;
    if (fittedWidth !== null) {
      setFittedWidth(null);
    } else {
      const zoomScale = zoomScaleRef.current;
      const screenW = Dimensions.get('window').width;
      setFittedWidth(Math.round(screenW / zoomScale));
    }
  }, [fittedWidth]);

  const resetFit = useCallback(() => {
    fitChangingRef.current = true;
    setFittedWidth(null);
  }, []);

  // Keep the ref fresh so the header menu reads the latest transcript.
  messagesRef.current = messages;
  const isEmpty = messages.length === 0;

  // Header overflow menu: Fit Width toggle + share the whole conversation as Markdown.
  const openMenu = useCallback(() => {
    Alert.alert('Chat options', undefined, [
      { text: wide ? 'Reset Fit' : 'Fit Width', onPress: toggleFit },
      {
        text: 'Share conversation',
        onPress: () => {
          const msgs = messagesRef.current;
          if (msgs.length === 0) {
            Alert.alert('Nothing to share', 'This chat is empty.');
            return;
          }
          void shareConversation(route.params?.title ?? 'Chat', msgs, Date.now());
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [wide, toggleFit, route.params?.title]);

  useLayoutEffect(() => {
    const title = incognito ? 'Incognito' : (route.params?.title ?? 'Claude');
    navigation.setOptions({
      headerLeft: () => (
        <Pressable onPress={() => setSidebarOpen(true)} hitSlop={10}>
          <Text style={styles.headerAction}>☰</Text>
        </Pressable>
      ),
      headerTitle: () => (
        <Pressable onPress={promptRename} hitSlop={8} disabled={!conversationId}>
          <Text
            style={[styles.headerTitle, incognito && styles.headerTitleIncognito]}
            numberOfLines={1}
          >
            {title}
          </Text>
        </Pressable>
      ),
      headerRight: () => (
        <View style={styles.headerRightRow}>
          {isEmpty && !conversationId ? (
            <Pressable onPress={() => startNewChat(!incognito)} hitSlop={8}>
              <Text style={[styles.headerAction, incognito && styles.headerActionActive]}>👻</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={openMenu} onLongPress={resetFit} hitSlop={8}>
            <Text style={styles.headerAction}>•••</Text>
          </Pressable>
        </View>
      ),
    });
  }, [
    navigation,
    route.params?.title,
    conversationId,
    incognito,
    isEmpty,
    promptRename,
    openMenu,
    resetFit,
    startNewChat,
    styles,
  ]);

  // ---- Transcript ------------------------------------------------------------

  const scrollToEnd = useCallback((animated = true) => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
  }, []);

  // When the keyboard opens to type a follow-up, re-pin to the bottom so the latest
  // messages aren't left hidden behind the input bar.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => scrollToEnd(true));
    return () => sub.remove();
  }, [scrollToEnd]);

  const lastAssistantId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  })();

  // Long-press a user bubble → edit it (regenerates from that point).
  const requestEdit = useCallback(
    (m: Message) => {
      if (busy) return;
      composerRef.current?.startEditing(m.id, m.content);
    },
    [busy],
  );

  const onEditSubmit = useCallback(
    (messageId: string, text: string) => void editAndResend(messageId, text),
    [editAndResend],
  );

  // Build the content container style.
  // flexGrow:1 is applied only for the empty state so the greeting centres vertically.
  // When messages exist, the container should be exactly as tall as its content — no
  // artificial padding — so after a "Fit Width" reflow the scroll view can't land in
  // blank space that doesn't correspond to any message.
  const listContentStyle = useMemo(
    () => [
      styles.listContent,
      isEmpty && styles.listContentGrow,
      fittedWidth !== null && { paddingHorizontal: 0, width: fittedWidth },
    ],
    [styles.listContent, isEmpty, fittedWidth],
  );

  // A plain ScrollView (not a virtualized FlatList): pinch-zoom on iOS interferes with
  // FlatList's windowing, which left messages below the first screen blank even though you
  // could scroll to them. A ScrollView renders every bubble, so scrolled content always shows,
  // and its native pinch-zoom is reliable.
  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      >
        {incognito && !isEmpty ? (
          <View style={styles.incognitoBar}>
            <Text style={styles.incognitoBarText}>👻 Incognito — this chat won’t be saved</Text>
          </View>
        ) : null}

        <ScrollView
          ref={listRef}
          style={styles.flex}
          contentContainerStyle={listContentStyle}
          keyboardShouldPersistTaps="handled"
          // Pinch to zoom the conversation (iOS), like a web page. Min 0.5 = half size.
          minimumZoomScale={Platform.OS === 'ios' ? 0.5 : undefined}
          maximumZoomScale={Platform.OS === 'ios' ? 3 : undefined}
          bouncesZoom={Platform.OS === 'ios'}
          scrollEventThrottle={16}
          onScroll={(e) => {
            scrollYRef.current = e.nativeEvent.contentOffset.y;
            // zoomScale is iOS-only; read it so toggleFit can compute the right width.
            const z = (e.nativeEvent as any).zoomScale;
            if (typeof z === 'number' && z > 0) zoomScaleRef.current = z;
          }}
          onContentSizeChange={() => {
            // After a "Fit Width" reflow: restore preserved position instead of jumping
            // to end. scrollToEnd() ignores native zoom scale → overshoots content
            // bounds → blank screen.
            if (fitChangingRef.current) {
              fitChangingRef.current = false;
              requestAnimationFrame(() =>
                listRef.current?.scrollTo({ x: 0, y: scrollYRef.current, animated: false })
              );
              return;
            }
            scrollToEnd();
          }}
        >
          {isEmpty ? (
            <GreetingHeader incognito={incognito} />
          ) : (
            messages.map((item) => {
              const isLastAssistant = item.id === lastAssistantId;
              return (
                <MessageBubble
                  key={item.id}
                  message={item}
                  busy={busy}
                  wide={wide}
                  isLastAssistant={isLastAssistant}
                  // Only the last assistant bubble gets live handlers; every other bubble
                  // keeps stable undefined props so memo() actually skips re-renders.
                  onRegenerate={isLastAssistant ? regenerate : undefined}
                  onContinue={isLastAssistant ? continueReply : undefined}
                  onEditRequest={item.role === 'user' ? requestEdit : undefined}
                />
              );
            })
          )}
        </ScrollView>

        {waking ? <StatusBanner text="Waking Claude up…" /> : null}
        {searching ? (
          <StatusBanner
            text={
              searching.name === 'Thinking'
                ? 'Thinking…'
                : searching.query
                  ? `Searching the web: ${searching.query}`
                  : 'Searching the web…'
            }
          />
        ) : null}

        {error ? (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Composer
          ref={composerRef}
          busy={busy}
          modelLabel={modelLabel}
          thinking={settings.thinking}
          incognito={incognito}
          onSend={send}
          onStop={stop}
          onOpenModelSheet={() => setModelSheetOpen(true)}
          onEditSubmit={onEditSubmit}
        />
      </KeyboardAvoidingView>

      <Sidebar
        visible={sidebarOpen}
        activeConversationId={conversationId}
        onClose={() => setSidebarOpen(false)}
        onSelectConversation={openConversation}
        onNewChat={() => startNewChat(false)}
        onOpenProjects={() => {
          setSidebarOpen(false);
          navigation.navigate('Projects');
        }}
        onOpenHistory={() => {
          setSidebarOpen(false);
          navigation.navigate('ConversationList');
        }}
        onOpenSettings={() => {
          setSidebarOpen(false);
          navigation.navigate('Settings');
        }}
      />

      <ModelSheet
        visible={modelSheetOpen}
        models={sheetModels}
        selectedId={currentModel}
        thinking={settings.thinking}
        onSelect={selectModel}
        onThinkingChange={setThinking}
        onClose={() => setModelSheetOpen(false)}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    screen: { flex: 1, backgroundColor: c.bg },
    headerTitle: { color: c.textStrong, fontSize: 17, fontWeight: '600', maxWidth: 200 },
    headerTitleIncognito: { fontStyle: 'italic' },
    headerRightRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    headerAction: { color: c.textStrong, fontSize: 17, fontWeight: '600' },
    headerActionActive: { color: c.accent },
    incognitoBar: {
      backgroundColor: c.surfaceAlt,
      paddingVertical: spacing.xs,
      alignItems: 'center',
    },
    incognitoBarText: { color: c.textMuted, fontSize: 12 },
    // No flexGrow here — content is exactly as tall as its messages (see listContentGrow).
    listContent: { padding: spacing.md, paddingBottom: spacing.lg },
    // Only applied for the empty state so the greeting centres within the scroll frame.
    listContentGrow: { flexGrow: 1 },
    errorBar: { backgroundColor: c.errorBg, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    errorText: { color: c.errorText, fontSize: 13 },
  });

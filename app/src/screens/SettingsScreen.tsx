// Runtime settings: appearance (light/dark/system), custom instructions, and — behind an
// explicit unlock — the server URL/secret. The connection fields are locked by default so
// they can't be changed by accident (a wrong URL/secret silently breaks the app).
// "Test connection" pings /api/health. Model + thinking moved to the composer's pill.
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSettings } from '../state/SettingsContext';
import { useTheme } from '../state/ThemeContext';
import { defaultSettings, type ThemeMode } from '../storage/settings';
import { pingHealth } from '../api';
import { radius, spacing, type Colors } from '../theme';

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

export function SettingsScreen() {
  const { settings, update, reset } = useSettings();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [secret, setSecret] = useState(settings.appSharedSecret);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  // Connection fields are read-only until the user explicitly unlocks them.
  const [unlocked, setUnlocked] = useState(false);

  const save = async () => {
    await update({
      serverUrl: serverUrl.trim().replace(/\/$/, ''),
      appSharedSecret: secret.trim(),
      systemPrompt,
    });
    setSaved(true);
    setUnlocked(false);
    setTimeout(() => setSaved(false), 1500);
  };

  // Appearance applies immediately (no Save needed) so the change is visible at once.
  const setThemeMode = (mode: ThemeMode) => void update({ themeMode: mode });

  const test = async () => {
    setTesting(true);
    const ok = await pingHealth({ serverUrl: serverUrl.trim().replace(/\/$/, '') });
    setTesting(false);
    Alert.alert(ok ? 'Connected' : 'No response', ok ? 'Server is reachable.' : 'Could not reach the server.');
  };

  const unlock = () =>
    Alert.alert(
      'Edit connection settings?',
      'These let the app reach Claude. A wrong URL or secret will stop it working. Only change them if you know what you’re doing.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Edit', style: 'destructive', onPress: () => setUnlocked(true) },
      ],
    );

  const doReset = () =>
    Alert.alert('Reset settings?', 'Restore the built-in defaults.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          await reset();
          const d = defaultSettings();
          setServerUrl(d.serverUrl);
          setSecret(d.appSharedSecret);
          setSystemPrompt(d.systemPrompt);
          setUnlocked(false);
        },
      },
    ]);

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Appearance</Text>
        <View style={styles.models}>
          {THEME_OPTIONS.map((t) => (
            <Pressable
              key={t.value}
              style={[styles.modelChip, settings.themeMode === t.value && styles.modelChipActive]}
              onPress={() => setThemeMode(t.value)}
            >
              <Text
                style={[styles.modelText, settings.themeMode === t.value && styles.modelTextActive]}
              >
                {t.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Custom instructions (optional)</Text>
        <Text style={styles.caption}>
          Standing instructions Claude follows in every chat — e.g. “Be concise”, “Explain like
          I’m new to coding”, or “Reply in British English”. Leave blank to use Claude’s normal
          behaviour. (This sets the system prompt; it won’t break anything.)
        </Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={systemPrompt}
          onChangeText={setSystemPrompt}
          multiline
          placeholder="e.g. Keep answers short and to the point."
          placeholderTextColor={colors.textMuted}
        />

        <Pressable style={styles.primary} onPress={save}>
          <Text style={styles.primaryText}>{saved ? 'Saved ✓' : 'Save'}</Text>
        </Pressable>

        {/* Connection section — locked by default. */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Connection</Text>
          {unlocked ? (
            <Text style={styles.unlockHint}>Editing</Text>
          ) : (
            <Pressable onPress={unlock} hitSlop={8}>
              <Text style={styles.editLink}>🔒 Edit</Text>
            </Pressable>
          )}
        </View>

        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={[styles.input, !unlocked && styles.inputLocked]}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
          editable={unlocked}
          placeholder="https://…"
          placeholderTextColor={colors.textMuted}
        />

        <Text style={styles.label}>Shared secret</Text>
        <TextInput
          style={[styles.input, !unlocked && styles.inputLocked]}
          value={secret}
          onChangeText={setSecret}
          autoCapitalize="none"
          autoCorrect={false}
          editable={unlocked}
          secureTextEntry
          placeholder="x-app-secret"
          placeholderTextColor={colors.textMuted}
        />

        <Pressable style={styles.secondary} onPress={test} disabled={testing}>
          <Text style={styles.secondaryText}>{testing ? 'Testing…' : 'Test connection'}</Text>
        </Pressable>
        <Pressable style={styles.reset} onPress={doReset}>
          <Text style={styles.resetText}>Reset to defaults</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    content: { padding: spacing.lg, gap: spacing.sm },
    label: { color: c.textMuted, fontSize: 13, marginTop: spacing.md, fontWeight: '600' },
    input: {
      backgroundColor: c.surface,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      color: c.textStrong,
      fontSize: 15,
    },
    inputLocked: { color: c.textMuted, opacity: 0.7 },
    caption: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
    multiline: { minHeight: 90, textAlignVertical: 'top' },
    models: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    modelChip: {
      backgroundColor: c.surface,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    modelChipActive: { borderColor: c.accent },
    modelText: { color: c.text, fontSize: 14 },
    modelTextActive: { color: c.accent, fontWeight: '600' },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: spacing.lg + spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: spacing.lg,
    },
    sectionTitle: { color: c.textStrong, fontSize: 16, fontWeight: '700' },
    editLink: { color: c.accent, fontSize: 14, fontWeight: '600' },
    unlockHint: { color: c.textMuted, fontSize: 13, fontStyle: 'italic' },
    primary: {
      backgroundColor: c.accent,
      borderRadius: radius.pill,
      paddingVertical: spacing.md,
      alignItems: 'center',
      marginTop: spacing.lg,
    },
    primaryText: { color: c.textOnAccent, fontSize: 16, fontWeight: '700' },
    secondary: {
      backgroundColor: c.surface,
      borderRadius: radius.pill,
      paddingVertical: spacing.md,
      alignItems: 'center',
      marginTop: spacing.sm,
    },
    secondaryText: { color: c.text, fontSize: 15, fontWeight: '600' },
    reset: { paddingVertical: spacing.md, alignItems: 'center' },
    resetText: { color: c.textMuted, fontSize: 14 },
  });

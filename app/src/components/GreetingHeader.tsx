// Centered new-chat greeting, official-app style: the starburst plus a time-of-day
// greeting. Shown in place of the transcript while a chat is still empty.
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../state/ThemeContext';
import { spacing, type Colors } from '../theme';
import { ClaudeMascot } from './ClaudeMascot';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Up late?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function GreetingHeader({ incognito }: { incognito?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.wrap}>
      <ClaudeMascot size={64} color={colors.accent} />
      <Text style={styles.greeting}>{incognito ? 'Incognito chat' : greeting()}</Text>
      <Text style={styles.sub}>
        {incognito
          ? 'This conversation won’t be saved to your history.'
          : 'How can I help you today?'}
      </Text>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
    greeting: { color: c.textStrong, fontSize: 24, fontWeight: '700', marginTop: spacing.sm },
    sub: { color: c.textMuted, fontSize: 15, textAlign: 'center' },
  });

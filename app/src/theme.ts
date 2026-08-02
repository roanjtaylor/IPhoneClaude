// Central palettes + spacing for the Claude-styled UI, matched to the official Claude app's
// design tokens (warm off-whites / warm dark greys; coral is a brand accent only — user
// bubble, send button, logo, links — never structural chrome). Which palette is active is
// resolved at runtime from the OS appearance (or a Settings override) by state/ThemeContext,
// which hands the right palette to every screen via useTheme(). `radius`/`spacing` are
// appearance-independent.

export type Colors = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  /** Stronger hairline for prominent separators — pair with StyleSheet.hairlineWidth. */
  hairline: string;
  accent: string;
  accentDim: string;
  text: string;
  textStrong: string;
  textOnAccent: string;
  textMuted: string;
  textFaint: string;
  link: string;
  codeBg: string;
  codeText: string;
  errorBg: string;
  errorText: string;
  successText: string;
  warningText: string;
};

// Official dark tokens: canvas #262624, raised surfaces #30302E, deepest #141413.
export const darkColors: Colors = {
  bg: '#262624',
  surface: '#30302E',
  surfaceAlt: '#141413',
  border: 'rgba(222,220,209,0.15)',
  hairline: 'rgba(222,220,209,0.30)',
  accent: '#d97757', // Claude clay-orange (user bubble, send button, logo).
  accentDim: '#4a4a46',
  text: '#c2c0b6',
  textStrong: '#faf9f5',
  textOnAccent: '#ffffff',
  textMuted: '#9c9a92',
  textFaint: '#807e76',
  link: '#e3a48b',
  codeBg: '#1d1d1b',
  codeText: '#e6b3a0',
  errorBg: '#602a28',
  errorText: '#f7ecec',
  successText: '#a3c98a',
  warningText: '#d6bc76',
};

// Official light tokens: white canvas, warm paper surfaces #F5F4ED / #FAF9F5, near-black
// warm text #141413. Accent darkened for contrast on white.
export const lightColors: Colors = {
  bg: '#ffffff',
  surface: '#f5f4ed',
  surfaceAlt: '#faf9f5',
  border: 'rgba(31,30,29,0.15)',
  hairline: 'rgba(31,30,29,0.30)',
  accent: '#c15f3c',
  accentDim: '#dcc7bd',
  text: '#3d3d3a',
  textStrong: '#141413',
  textOnAccent: '#ffffff',
  textMuted: '#73726c',
  textFaint: '#9c9a92',
  link: '#b5562f',
  codeBg: '#f5f4ed',
  codeText: '#a64b27',
  errorBg: '#f7ecec',
  errorText: '#602a28',
  successText: '#1b4614',
  warningText: '#483a0f',
};

export type Scheme = 'light' | 'dark';

export function palette(scheme: Scheme): Colors {
  return scheme === 'light' ? lightColors : darkColors;
}

// Official radius scale plus the app's legacy semantic aliases.
export const radius = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  bubble: 18,
  input: 24,
  pill: 999,
  card: 12,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
} as const;

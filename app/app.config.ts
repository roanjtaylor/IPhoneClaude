// Dynamic Expo config. Replaces the static parts of app.json so the shared secret can
// come from the environment (an EAS build-time secret in production, a gitignored .env in
// local dev) instead of being committed in source. The runtime Settings screen can still
// override it without a rebuild. See plan: Settings & secret management.
import 'dotenv/config';
import type { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Claude7',
  slug: 'claude7',
  owner: 'roanjtaylor',
  version: '1.0.0',
  // 'default' lets the phone rotate to landscape so wide tables/code blocks have room.
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  icon: './assets/icon.png',
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.roanjtaylor.claude7',
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  plugins: [
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '15.1' },
      },
    ],
    'expo-asset',
    'expo-sqlite',
    [
      'expo-splash-screen',
      {
        // Coral sampled from the claude.png edge so the splash square blends in.
        image: './assets/splash-icon.png',
        backgroundColor: '#DA7453',
        imageWidth: 200,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Claude7 needs photo access to attach images to your messages.',
        cameraPermission: 'Claude7 needs camera access to attach photos to your messages.',
      },
    ],
    [
      'expo-media-library',
      {
        savePhotosPermission: 'Claude7 needs permission to save images to your photo library.',
        isAccessMediaLocationEnabled: false,
      },
    ],
  ],
  extra: {
    serverUrl: process.env.SERVER_URL ?? 'https://roanjtaylor-claudesubscription.hf.space',
    // From EAS secret (production) or .env (local dev). Empty here means "set it in the
    // app's Settings screen at runtime."
    appSharedSecret: process.env.APP_SHARED_SECRET ?? '',
    eas: {
      projectId: 'b5edb3ab-0c57-4b37-b3ee-af32fcdec02d',
    },
  },
});

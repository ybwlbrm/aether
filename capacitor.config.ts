import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pacc.app',
  appName: 'Aether Mobile',
  webDir: 'src/mobile/dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
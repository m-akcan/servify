import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cloud.servify.app',
  appName: 'Servify',
  webDir: 'dist',
  server: {
    // Servify on a home network or VPN is usually plain HTTP. An https:// app page could not
    // call it (mixed content), so the app itself is served as http://localhost.
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0b0c0a',
  },
  plugins: {
    // Edge to edge: the page draws under the status and navigation bars and pads itself with
    // the --safe-area-inset-* variables Capacitor injects.
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover' },
  },
};

export default config;

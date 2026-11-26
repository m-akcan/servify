import { createRoot } from 'react-dom/client';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { App } from './App.tsx';

/** Follow the phone's light/dark setting, including when it changes while the app is open. */
function applyTheme() {
  const dark = !window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (Capacitor.isNativePlatform()) void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
}
applyTheme();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

createRoot(document.getElementById('root')!).render(<App />);

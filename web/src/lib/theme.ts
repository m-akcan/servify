export type ThemePref = 'dark' | 'light' | 'system';

export function getThemePref(): ThemePref {
  try {
    return (localStorage.getItem('servify.theme') as ThemePref) || 'dark';
  } catch {
    return 'dark';
  }
}

export function resolvedTheme(pref = getThemePref()): 'dark' | 'light' {
  if (pref === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return pref;
}

export function applyTheme(pref = getThemePref()) {
  document.documentElement.dataset.theme = resolvedTheme(pref);
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem('servify.theme', pref);
  } catch {}
  // Cross-fade the whole UI instead of snapping colors.
  const root = document.documentElement;
  root.classList.add('theme-fade');
  applyTheme(pref);
  setTimeout(() => root.classList.remove('theme-fade'), 420);
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (getThemePref() === 'system') applyTheme();
});

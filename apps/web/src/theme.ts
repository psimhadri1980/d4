import { THEME_EVENT } from '@d4/ui-kit';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'd4-theme';
export { THEME_EVENT };

export function storedTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Applies a theme (`system` follows the OS) and notifies canvases that read colour tokens. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    // Storage may be unavailable (private mode); the choice still applies for this page.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Re-notify when the OS theme flips while following the system. */
export function watchSystemTheme(): void {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (storedTheme() === 'system') window.dispatchEvent(new Event(THEME_EVENT));
  });
}

/**
 * Application theme.
 *
 * Three user choices — 'light', 'dark' and 'system'. Only an explicit light or
 * dark choice is stored; 'system' is represented by the absence of a stored
 * value, so an account that has never chosen simply follows the OS, and keeps
 * following it if the OS setting changes later.
 *
 * The resolved theme is stamped on <html data-theme>, which is the single
 * switch every token in index.css hangs off. The same resolution runs inline in
 * index.html before first paint — keep the two in step.
 */
const STORAGE_KEY = 'td_theme';

/** What the OS is asking for right now. */
export function systemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** The user's choice: 'light' | 'dark' | 'system'. */
export function getPreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** The theme actually in effect: 'light' | 'dark'. */
export function resolveTheme(preference = getPreference()) {
  return preference === 'system' ? systemTheme() : preference;
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Record a choice and apply it. Passing 'system' clears the stored value so the
 * OS takes over again.
 */
export function setPreference(preference) {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* storage blocked — the theme still applies for this session */
  }
  apply(resolveTheme(preference));
  return preference;
}

/**
 * Follow the OS while the user is on 'system'. Returns an unsubscribe function.
 */
export function watchSystem(onChange) {
  let media;
  try {
    media = window.matchMedia('(prefers-color-scheme: light)');
  } catch {
    return () => {};
  }
  const handler = () => {
    if (getPreference() !== 'system') return;
    const theme = systemTheme();
    apply(theme);
    if (onChange) onChange(theme);
  };
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}

/**
 * Re-apply on mount (in case storage changed in another tab) and release the
 * first-paint transition lock set by the inline script in index.html.
 */
export function initTheme() {
  apply(resolveTheme());
  requestAnimationFrame(() => {
    document.documentElement.classList.remove('theme-boot');
  });
}

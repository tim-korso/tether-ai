export const THEMES = [
  "white",
  "paper",
  "dark",
  "glass",
  "glass-red",
  "glass-amber",
  "glass-cosmos",
] as const;
export type ThemeId = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeId = "paper";
export const THEME_STORAGE_KEY = "tether.theme";

/**
 * The glass family: one translucent design, several hues. Each id here is driven
 * by the shared `[data-theme|="glass"]` block in styles.css, so adding a hue is a
 * palette block there plus an entry in this list — nothing else in the shell has
 * to know about it.
 */
export const GLASS_THEMES = [
  "glass",
  "glass-red",
  "glass-amber",
  "glass-cosmos",
] as const;
export type GlassThemeId = (typeof GLASS_THEMES)[number];

export function isGlassTheme(id: ThemeId): id is GlassThemeId {
  return (GLASS_THEMES as readonly ThemeId[]).includes(id);
}

/** Palettes that paint light-on-dark; drives `color-scheme` and the native material. */
export function isDarkTheme(id: ThemeId): boolean {
  return id === "dark" || id === "glass-cosmos";
}

/**
 * macOS only: which NSVisualEffectView material sits behind the window. The light
 * glass hues want the light frosted material; cosmos is a night sky and needs a
 * dark one, otherwise the page reads as washed-out grey no matter what the CSS
 * says. The renderer reports this to `window:set-vibrancy` in src/main/index.ts.
 */
export type VibrancyMaterial = "under-window" | "hud";

export function vibrancyForTheme(id: ThemeId): VibrancyMaterial {
  return isDarkTheme(id) ? "hud" : "under-window";
}

export function parseTheme(value: unknown): ThemeId {
  return THEMES.includes(value as ThemeId) ? (value as ThemeId) : DEFAULT_THEME;
}

export function readStoredTheme(): ThemeId {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: ThemeId): ThemeId {
  const next = parseTheme(theme);
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = isDarkTheme(next) ? "dark" : "light";
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* private mode */
  }
  return next;
}

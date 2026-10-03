import { useEffect, useLayoutEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
export interface Preferences {
  readonly theme: Theme;
  readonly reducedMotion: boolean;
  readonly sidebarCollapsed: boolean;
}

const PREFERENCES_KEY = "gauntlet.preferences.v1";
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  theme: "light",
  reducedMotion: false,
  sidebarCollapsed: false,
});

function decodePreferences(raw: string | null): Preferences {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null) return DEFAULT_PREFERENCES;
    const data = value as Record<string, unknown>;
    return {
      theme:
        data.theme === "dark" || data.theme === "system" ? data.theme : "light",
      reducedMotion: data.reducedMotion === true,
      sidebarCollapsed: data.sidebarCollapsed === true,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function readPreferences(): Preferences {
  try {
    return decodePreferences(globalThis.localStorage.getItem(PREFERENCES_KEY));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function resolveTheme(theme: Theme, systemDark: boolean): "light" | "dark" {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

export function applyPreferences(preferences: Preferences): void {
  const root = document.documentElement;
  const theme = resolveTheme(
    preferences.theme,
    globalThis.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  root.dataset.motion = preferences.reducedMotion ? "reduce" : "system";
}

export function usePreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [saved, setSaved] = useState(true);

  useLayoutEffect(() => {
    applyPreferences(preferences);
    const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyPreferences(preferences);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preferences]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== PREFERENCES_KEY) return;
      setPreferences(readPreferences());
      setSaved(true);
    };
    globalThis.addEventListener("storage", onStorage);
    return () => globalThis.removeEventListener("storage", onStorage);
  }, []);

  const updatePreferences = (changes: Partial<Preferences>) => {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    try {
      globalThis.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
      setSaved(true);
    } catch {
      // Preferences still work for this tab when browser storage is unavailable.
      setSaved(false);
    }
  };

  return { preferences, updatePreferences, saved };
}

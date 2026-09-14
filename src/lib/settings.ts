import { useSyncExternalStore } from "react";

export type SortMode = "added" | "author" | "random";

export interface Settings {
  /** Minimum card width in px; drives the column count. */
  colW: number;
  gap: number;
  showCaptions: boolean;
  showAuthors: boolean;
  rounded: boolean;
  sort: SortMode;
}

export const DEFAULT_SETTINGS: Settings = {
  colW: 196,
  gap: 12,
  showCaptions: true,
  showAuthors: true,
  rounded: true,
  sort: "added",
};

const KEY = "looks.settings.v1";

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage may be unavailable; settings still apply for the session */
  }
}

/** Canvas font string; keep in sync with --font-mono in globals.css. */
export const UI_FONT =
  '11px ui-monospace, "SF Mono", Menlo, "JetBrains Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace';

/* ------------------------------------------------------------ tiny store */


let current: Settings | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): Settings {
  if (!current) current = loadSettings();
  return current;
}

function getServerSnapshot(): Settings {
  return DEFAULT_SETTINGS;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...getSnapshot(), ...patch };
  saveSettings(current);
  listeners.forEach((fn) => fn());
}

export function resetSettings() {
  current = DEFAULT_SETTINGS;
  saveSettings(current);
  listeners.forEach((fn) => fn());
}

/** Settings hook: server renders defaults, the client hydrates from storage. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Theme state — dark by default, light on request.
 *
 * The source of truth at runtime is the `data-theme` attribute on <html>. It
 * is stamped by the inline script in index.html *before first paint*, so the
 * app never flashes the wrong canvas; everything here simply keeps that
 * attribute, localStorage and React in sync.
 *
 * localStorage access is wrapped: a WebView with storage disabled throws on
 * every touch, and a theme preference is never worth crashing the shell over.
 */

import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

/** Also read by the no-flash script in index.html — keep the two in step. */
export const THEME_STORAGE_KEY = "tutor.theme";

export const DEFAULT_THEME: Theme = "dark";

/** Browser-chrome colour per theme, mirrored into <meta name="theme-color">. */
const THEME_COLOR: Record<Theme, string> = {
  dark: "#0A0B0F",
  light: "#F6F7F9",
};

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

function readStored(): Theme | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStored(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* Storage unavailable — the choice simply does not survive a reload. */
  }
}

/** The theme currently painted: the DOM wins, then storage, then the default. */
export function getTheme(): Theme {
  if (typeof document !== "undefined") {
    const stamped = document.documentElement.getAttribute("data-theme");
    if (isTheme(stamped)) return stamped;
  }
  if (typeof window === "undefined") return DEFAULT_THEME;
  return readStored() ?? DEFAULT_THEME;
}

/** Paints a theme without persisting it. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[theme]);
}

/* React needs telling: the attribute lives outside the tree. */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Persists, paints and notifies every subscriber. */
export function setTheme(theme: Theme): void {
  writeStored(theme);
  applyTheme(theme);
  emit();
}

/** Flips dark ⇄ light and returns the theme that is now active. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `const [theme, setTheme] = useTheme()`. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => DEFAULT_THEME);
  return [theme, setTheme];
}

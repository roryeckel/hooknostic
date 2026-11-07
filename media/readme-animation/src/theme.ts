import { createContext, useContext } from "react";

import type { Level } from "./facts";

export type ThemeName = "dark" | "light";

export interface Theme {
  bg: string;
  fg: string;
  muted: string;
  panel: string;
  border: string;
  danger: string;
  success: string;
  levels: Record<Level, string>;
  syntax: { keyword: string; string: string; call: string; property: string; punctuation: string };
}

// The mark's side gradient (docs/assets/hooknostic-mark.svg), shared by both themes.
export const BRAND = ["#10a37f", "#b9a25a", "#d97757"] as const;

// GitHub's own canvas colors, so each GIF sits flush on the matching README theme.
export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    bg: "#0d1117",
    fg: "#e6edf3",
    muted: "#8b949e",
    panel: "#161b22",
    border: "#30363d",
    danger: "#f85149",
    success: "#3fb950",
    levels: { exact: "#3fb950", emulated: "#58a6ff", approximate: "#d29922", unsupported: "#8b949e" },
    syntax: { keyword: "#ff7b72", string: "#a5d6ff", call: "#d2a8ff", property: "#79c0ff", punctuation: "#e6edf3" },
  },
  light: {
    bg: "#ffffff",
    fg: "#1f2328",
    muted: "#59636e",
    panel: "#f6f8fa",
    border: "#d1d9e0",
    danger: "#cf222e",
    success: "#1a7f37",
    levels: { exact: "#1a7f37", emulated: "#0969da", approximate: "#9a6700", unsupported: "#59636e" },
    syntax: { keyword: "#cf222e", string: "#0a3069", call: "#8250df", property: "#0550ae", punctuation: "#1f2328" },
  },
};

const ThemeContext = createContext<Theme>(THEMES.dark);
export const ThemeProvider = ThemeContext.Provider;
export const useTheme = () => useContext(ThemeContext);

// `color` at `alpha` (0-1) as an 8-digit hex, for tinted fills.
export const tint = (color: string, alpha: number) =>
  `${color}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;

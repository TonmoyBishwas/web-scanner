/**
 * Design tokens — TypeScript mirror of the CSS variables in app/globals.css.
 *
 * Prefer Tailwind classes (`bg-surface-1`, `text-text-secondary`,
 * `border-border-default`, etc.) over reading from this file. Use these
 * constants ONLY when you need a raw value:
 *  - inline `style={{ ... }}` (dynamic colors)
 *  - canvas / SVG fills
 *  - JS-driven animations
 *
 * If you change a value here, change it in `app/globals.css` too —
 * they MUST stay in sync.
 */

export const colors = {
  // Surfaces (lightest → deepest)
  surface0: "#fafaf7",
  surface1: "#ffffff",
  surface2: "#f4f4f0",
  surface3: "#e8e8e2",

  // Borders
  borderDefault: "#ececea",
  borderStrong: "#d4d4cc",

  // Text
  textPrimary: "#0a0a0a",
  textSecondary: "#5b5b5b",
  textTertiary: "#9a9a96",

  // Accent — calm near-black for primary buttons (iOS feel)
  accent: "#0a0a0a",
  accentPressed: "#2a2a2a",
  accentSoft: "rgba(10, 10, 10, 0.06)",
  accentRing: "rgba(10, 10, 10, 0.22)",

  // State
  success: "#15803d",
  successSoft: "#e7f5ec",
  warning: "#b45309",
  warningSoft: "#fcf2e3",
  danger: "#b91c1c",
  dangerSoft: "#fdeaea",
} as const;

export type ColorToken = keyof typeof colors;

/** Geometry — generous corners read minimal/clean (iOS feel). */
export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 9999,
} as const;

/** Minimum tap target. Primary buttons should be `h-14` / 56 px. */
export const minTap = 48;

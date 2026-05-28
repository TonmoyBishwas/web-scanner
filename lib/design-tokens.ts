/**
 * Design tokens — TypeScript mirror of the CSS variables in app/globals.css.
 *
 * Prefer Tailwind classes (e.g. `bg-surface-1`, `text-text-secondary`, `border-border-default`)
 * over reading from this file. Use these constants ONLY when you need a raw value:
 * - inline `style={{ ... }}` props (e.g. dynamic accent color on the scanner overlay)
 * - canvas / SVG fill values
 * - JS-driven animations
 *
 * If you change a value here, change it in `app/globals.css` too — they MUST stay in sync.
 */

export const colors = {
  // Surfaces
  surface0: "#050505",
  surface1: "#0f0f10",
  surface2: "#1a1a1c",
  surface3: "#26262a",

  // Borders
  borderDefault: "#2a2a2e",
  borderStrong: "#3a3a40",

  // Text
  textPrimary: "#ffffff",
  textSecondary: "#a8a8ad",
  textTertiary: "#6b6b72",

  // Hi-vis accent
  accent: "#ff6b35",
  accentPressed: "#e85a26",
  accentSoft: "rgba(255, 107, 53, 0.12)",
  accentRing: "rgba(255, 107, 53, 0.35)",

  // State
  success: "#16a34a",
  successSoft: "rgba(22, 163, 74, 0.14)",
  warning: "#f59e0b",
  warningSoft: "rgba(245, 158, 11, 0.14)",
  danger: "#ef4444",
  dangerSoft: "rgba(239, 68, 68, 0.16)",
} as const;

export type ColorToken = keyof typeof colors;

/** Geometry — kept narrow on purpose; most spacing should use Tailwind classes. */
export const radii = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
} as const;

/** Minimum tap target. Buttons should be `h-14` (56px) or `h-12` (48px); never below 44. */
export const minTap = 44;

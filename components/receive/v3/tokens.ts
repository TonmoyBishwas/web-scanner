/**
 * Receive form v3 (06/11, flag receive_form_v3) — the design tokens.
 *
 * The prototype's palette "b" (light "paper"), the only one built. Colours are
 * CSS custom properties set on the v3 root (v3.module.css), so the app's dark
 * theme cannot leak in; `HEX` keeps the literal values (the root sets them,
 * the render test pins them). No shadows, gradients, glows or orange anywhere.
 */
import type { CSSProperties, FocusEvent } from 'react';

export const HEX = {
  bg: '#ffffff',
  surf: '#f5f4f1',
  line: '#e2e0db',
  line2: '#8c8982',
  ink: '#1d1c1a',
  ink2: '#5f5d58',
  acc: '#1d1c1a',
  accInk: '#ffffff',
  okText: '#1d7a3d',
  okFill: '#228547',
  okInk: '#ffffff',
  errText: '#b3261e',
  errFill: '#c9372c',
  overlay: 'rgba(29,28,26,.36)',
  viewerBg: '#141414',
  viewerLabel: '#d8d6d1',
  viewerX: '#ffffff',
} as const;

export type Token = keyof typeof HEX;

/** The palette as CSS variables (`var(--v3-ink)` …), for inline styles. */
export const P = Object.fromEntries(
  (Object.keys(HEX) as Token[]).map((k) => [k, `var(--v3-${k})`]),
) as Record<Token, string>;

/** The root's custom properties (also written in v3.module.css; kept here for the inline fallback). */
export const ROOT_VARS: CSSProperties = Object.fromEntries(
  (Object.keys(HEX) as Token[]).map((k) => [`--v3-${k}`, HEX[k]]),
) as CSSProperties;

/** The prototype's easing (`EO`). */
export const EO = 'cubic-bezier(.2,.8,.2,1)';

/** Rubik (next/font, `--font-v3`), with the system fallback. */
export const FAMILY = "var(--font-v3), 'Rubik', system-ui, sans-serif";

/**
 * The CSS `font` shorthand as the prototype writes it: `font(500, 15)` = "500 15px Rubik".
 * A line height under 4 is a ratio (`17px/1.4`), a larger one pixels (`13px/22px`).
 */
export function font(weight: 400 | 500 | 600 | 700, size: number, lineHeight?: number | string): string {
  const lh =
    lineHeight === undefined
      ? ''
      : `/${typeof lineHeight === 'number' ? (lineHeight < 4 ? String(lineHeight) : `${lineHeight}px`) : lineHeight}`;
  return `${weight} ${size}px${lh} ${FAMILY}`;
}

/** Underlined text link (1 px, 4 px offset). */
export const UNDERLINE: CSSProperties = {
  textDecoration: 'underline',
  textUnderlineOffset: 4,
  textDecorationThickness: 1,
};

/** A reset button: no border, no background, inherits the ink colour. */
export const BARE: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  color: P.ink,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
};

/** A square icon button (×, calendar …), centred content. */
export function iconBtn(w: number, h: number = w, color: string = P.ink): CSSProperties {
  return {
    ...BARE,
    width: w,
    height: h,
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color,
  };
}

/** Bidi-isolate a number or a code inside a Hebrew sentence (the prototype's `I()`). */
export const I = (x: string | number): string => `\u2068${x}\u2069`;

/** Overlay layers' z-index (the prototype's). */
export const Z = { sheet: 40, list: 45, error: 50, viewer: 70 } as const;

/**
 * A number field inside the list ("keyboard open", spec 6.2): focus selects
 * the text and hides header row 1, the bottom bar and the pallet rubric;
 * blur (150 ms debounce) brings them back.
 */
export interface KbHandlers {
  onFocus: (e: FocusEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}

/** A 2 px-bordered number input (the card's quantity / packages fields). */
export function numInput(width: number, height: number, size: number, border: string = P.line2): CSSProperties {
  return {
    width,
    flex: 'none',
    height,
    textAlign: 'center',
    font: font(600, size),
    background: P.bg,
    border: `2px solid ${border}`,
    borderRadius: 6,
    color: P.ink,
    outline: 'none',
    padding: 0,
  };
}

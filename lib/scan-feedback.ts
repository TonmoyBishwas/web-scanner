'use client';

import { useSettingsStore } from '@/stores/settings-store';

// ── Shared scan feedback ─────────────────────────────────────────────────
//
// One place for the audio + haptic cues fired on every scan, so all scanner
// pages (carton /scan, /issue, and pallet-verify) feel identical. Two events,
// deliberately distinct so the worker can tell them apart without looking:
//
//   success   — bright, short rising "ping"  + a single crisp tap
//   duplicate — two quick descending low buzzes + a double tap
//
// Both are gated by the user's Sound / Vibration toggles (persisted in
// localStorage via the settings store). Read imperatively with getState() so
// non-React call sites (the barcode-detected handlers) can use it directly.
// Before the store hydrates from localStorage (_hydrated === false) we default
// to ON, matching the store's optimistic defaults, so the first scans on a
// fresh page load still give feedback.

let _ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!_ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      _ctx = new Ctor();
    }
    // Mobile browsers suspend the context until a user gesture; resume() is a
    // no-op when it's already running. Scanning always follows the camera
    // permission tap, so by the first scan a gesture has occurred.
    if (_ctx.state === 'suspended') void _ctx.resume();
    return _ctx;
  } catch {
    return null;
  }
}

// Schedule one enveloped tone. `start` is an offset (seconds) from "now" so a
// cue can chain several tones into a short melody.
function tone(
  ctx: AudioContext,
  freq: number,
  type: OscillatorType,
  start: number,
  dur: number,
  peak: number
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + start;
  // Ramp from ~0 to peak and back so the tone doesn't click on/off.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function prefs() {
  const s = useSettingsStore.getState();
  return {
    sound: s.soundEnabled || !s._hydrated,
    vibe: s.vibrationEnabled || !s._hydrated,
  };
}

function vibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    // Vibration unsupported (iOS Safari) — sound still plays.
  }
}

// Good scan: a single bright rising ping + one short tap.
export function scanSuccessFeedback() {
  const { sound, vibe } = prefs();
  if (sound) {
    const ctx = getCtx();
    if (ctx) tone(ctx, 880, 'sine', 0, 0.12, 0.3);
  }
  if (vibe) vibrate(45);
}

// Duplicate scan: two quick descending low square buzzes + a double tap —
// clearly "you already scanned this", unmistakable against the success ping.
export function scanDuplicateFeedback() {
  const { sound, vibe } = prefs();
  if (sound) {
    const ctx = getCtx();
    if (ctx) {
      tone(ctx, 330, 'square', 0, 0.1, 0.18);
      tone(ctx, 220, 'square', 0.12, 0.14, 0.18);
    }
  }
  if (vibe) vibrate([130, 70, 130]);
}

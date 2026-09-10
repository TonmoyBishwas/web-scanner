import { create } from 'zustand';

export interface SettingsState {
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  /**
   * Tap anywhere on the live camera to capture the label.
   *
   * This is the answer to a torn / glared / folded barcode: auto-detect will
   * never fire on it, but the printed digits under it are still readable, so
   * the worker takes the picture himself and OCR resolves the box. It is the
   * ONLY way such a carton gets onto a pallet.
   *
   * Default ON. It used to be off, bundled into `hardwareTriggerEnabled`, and
   * reachable only from the drawer's Settings screen — which meant that in
   * practice nobody on the floor had it. The stray-tap worry it was protecting
   * against is handled properly now, in the gesture itself: a capture needs a
   * real tap (single finger, < TAP_MAX_MOVE_PX of travel, < TAP_MAX_MS), so a
   * swipe, a drag or a resting hand does nothing. The small on-screen
   * "capture anyway" button remains, and is what keyboard users get.
   */
  tapCaptureEnabled: boolean;
  /**
   * Bluetooth remote / ring-clicker keystroke fires the same manual capture.
   * Default OFF — it hijacks Enter/Space/volume keys globally, which is only
   * wanted by a worker who actually has a clicker paired.
   */
  hardwareTriggerEnabled: boolean;
  // The camera-switch chip on the live camera. Default OFF: workers kept
  // knocking it and landing on the ultrawide/front lens mid-pallet. Managers
  // can turn it back on from the drawer's Settings screen when a device
  // genuinely needs a different lens.
  cameraSwitchEnabled: boolean;
  _hydrated: boolean;
  toggleSound: () => void;
  toggleVibration: () => void;
  toggleTapCapture: () => void;
  toggleHardwareTrigger: () => void;
  toggleCameraSwitch: () => void;
  hydrate: () => void;
}

const STORAGE_KEY = 'scanner-settings';

function saveSettings(
  state: Pick<SettingsState, 'soundEnabled' | 'vibrationEnabled' | 'tapCaptureEnabled' | 'hardwareTriggerEnabled' | 'cameraSwitchEnabled'>
) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      soundEnabled: state.soundEnabled,
      vibrationEnabled: state.vibrationEnabled,
      tapCaptureEnabled: state.tapCaptureEnabled,
      hardwareTriggerEnabled: state.hardwareTriggerEnabled,
      cameraSwitchEnabled: state.cameraSwitchEnabled,
    }));
  } catch {}
}

export const useSettingsStore = create<SettingsState>((set) => ({
  // Server-safe defaults (match initial HTML render)
  soundEnabled: true,
  vibrationEnabled: true,
  tapCaptureEnabled: true,
  hardwareTriggerEnabled: false,
  cameraSwitchEnabled: false,
  _hydrated: false,

  hydrate: () => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        set({
          soundEnabled: saved.soundEnabled ?? true,
          vibrationEnabled: saved.vibrationEnabled ?? true,
          // Settings blobs written before tap-capture was split out of
          // `hardwareTriggerEnabled` have no key here. They get the new
          // default (on) rather than inheriting the old combined toggle —
          // an existing worker is exactly who was missing the gesture.
          tapCaptureEnabled: saved.tapCaptureEnabled ?? true,
          hardwareTriggerEnabled: saved.hardwareTriggerEnabled ?? false,
          cameraSwitchEnabled: saved.cameraSwitchEnabled ?? false,
          _hydrated: true,
        });
      } else {
        set({ _hydrated: true });
      }
    } catch {
      set({ _hydrated: true });
    }
  },

  toggleSound: () => {
    set(s => {
      const next = { ...s, soundEnabled: !s.soundEnabled };
      saveSettings(next);
      return next;
    });
  },

  toggleVibration: () => {
    set(s => {
      const next = { ...s, vibrationEnabled: !s.vibrationEnabled };
      saveSettings(next);
      return next;
    });
  },

  toggleTapCapture: () => {
    set(s => {
      const next = { ...s, tapCaptureEnabled: !s.tapCaptureEnabled };
      saveSettings(next);
      return next;
    });
  },

  toggleHardwareTrigger: () => {
    set(s => {
      const next = { ...s, hardwareTriggerEnabled: !s.hardwareTriggerEnabled };
      saveSettings(next);
      return next;
    });
  },

  toggleCameraSwitch: () => {
    set(s => {
      const next = { ...s, cameraSwitchEnabled: !s.cameraSwitchEnabled };
      saveSettings(next);
      return next;
    });
  },
}));

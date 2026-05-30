import { create } from 'zustand';

export interface SettingsState {
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  // Extra capture triggers: tap-anywhere-on-the-camera + a Bluetooth remote
  // keystroke. Default OFF so a stray tap can't fire a capture for workers who
  // don't want it. The on-screen capture button is always available regardless.
  hardwareTriggerEnabled: boolean;
  _hydrated: boolean;
  toggleSound: () => void;
  toggleVibration: () => void;
  toggleHardwareTrigger: () => void;
  hydrate: () => void;
}

const STORAGE_KEY = 'scanner-settings';

function saveSettings(
  state: Pick<SettingsState, 'soundEnabled' | 'vibrationEnabled' | 'hardwareTriggerEnabled'>
) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      soundEnabled: state.soundEnabled,
      vibrationEnabled: state.vibrationEnabled,
      hardwareTriggerEnabled: state.hardwareTriggerEnabled,
    }));
  } catch {}
}

export const useSettingsStore = create<SettingsState>((set) => ({
  // Server-safe defaults (match initial HTML render)
  soundEnabled: true,
  vibrationEnabled: true,
  hardwareTriggerEnabled: false,
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
          hardwareTriggerEnabled: saved.hardwareTriggerEnabled ?? false,
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

  toggleHardwareTrigger: () => {
    set(s => {
      const next = { ...s, hardwareTriggerEnabled: !s.hardwareTriggerEnabled };
      saveSettings(next);
      return next;
    });
  },
}));

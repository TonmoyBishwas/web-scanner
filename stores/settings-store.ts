import { create } from 'zustand';

export interface SettingsState {
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  theme: 'dark' | 'light';
  toggleSound: () => void;
  toggleVibration: () => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'scanner-settings';

function loadSettings(): Partial<SettingsState> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function saveSettings(state: Pick<SettingsState, 'soundEnabled' | 'vibrationEnabled' | 'theme'>) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      soundEnabled: state.soundEnabled,
      vibrationEnabled: state.vibrationEnabled,
      theme: state.theme,
    }));
  } catch {}
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const saved = loadSettings();
  return {
    soundEnabled: saved.soundEnabled ?? true,
    vibrationEnabled: saved.vibrationEnabled ?? true,
    theme: (saved.theme as 'dark' | 'light') ?? 'dark',

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

    toggleTheme: () => {
      set(s => {
        const next = { ...s, theme: s.theme === 'dark' ? 'light' as const : 'dark' as const };
        saveSettings(next);
        return next;
      });
    },
  };
});

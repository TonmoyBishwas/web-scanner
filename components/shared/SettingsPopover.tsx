'use client';

import { useState, useRef, useEffect } from 'react';
import { Settings, Volume2, VolumeX, Vibrate, Sun, Moon, X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';

export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { soundEnabled, vibrationEnabled, theme, toggleSound, toggleVibration, toggleTheme } = useSettingsStore();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen(!open)}
        className="p-2 rounded-lg hover:bg-white/10 dark:hover:bg-white/10 transition-colors"
        aria-label="Settings"
      >
        <Settings className="w-5 h-5 text-gray-400" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 bg-gray-800 dark:bg-gray-800 border border-gray-700 dark:border-gray-700 rounded-xl shadow-2xl z-[70] overflow-hidden animate-fadeIn">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
            <span className="text-sm font-semibold text-white">Settings</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-2 space-y-1">
            {/* Sound toggle */}
            <button
              onClick={toggleSound}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors"
            >
              <div className="flex items-center gap-3">
                {soundEnabled ? (
                  <Volume2 className="w-4 h-4 text-green-400" />
                ) : (
                  <VolumeX className="w-4 h-4 text-gray-500" />
                )}
                <span className="text-sm text-gray-200">Sound</span>
              </div>
              <TogglePill enabled={soundEnabled} />
            </button>

            {/* Vibration toggle */}
            <button
              onClick={toggleVibration}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Vibrate className={`w-4 h-4 ${vibrationEnabled ? 'text-green-400' : 'text-gray-500'}`} />
                <span className="text-sm text-gray-200">Vibration</span>
              </div>
              <TogglePill enabled={vibrationEnabled} />
            </button>

            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors"
            >
              <div className="flex items-center gap-3">
                {theme === 'dark' ? (
                  <Moon className="w-4 h-4 text-blue-400" />
                ) : (
                  <Sun className="w-4 h-4 text-yellow-400" />
                )}
                <span className="text-sm text-gray-200">
                  {theme === 'dark' ? 'Dark Mode' : 'Light Mode'}
                </span>
              </div>
              <span className="text-xs text-gray-500 capitalize">{theme}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TogglePill({ enabled }: { enabled: boolean }) {
  return (
    <div className={`w-9 h-5 rounded-full relative transition-colors ${enabled ? 'bg-green-500' : 'bg-gray-600'}`}>
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </div>
  );
}

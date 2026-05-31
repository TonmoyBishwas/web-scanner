'use client';

import { useState, useRef, useEffect } from 'react';
import { Settings, Volume2, VolumeX, Vibrate, Aperture, X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useT } from '@/lib/i18n';

export function SettingsPopover() {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const {
    soundEnabled,
    vibrationEnabled,
    hardwareTriggerEnabled,
    toggleSound,
    toggleVibration,
    toggleHardwareTrigger,
  } = useSettingsStore();

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
        className="p-2 rounded-lg hover:bg-hover transition-colors"
        aria-label={tr('components.settings.aria')}
      >
        <Settings className="w-5 h-5 text-ink-muted" />
      </button>

      {open && (
        <div className="absolute end-0 top-full mt-2 w-56 bg-raised border border-line rounded-xl shadow-2xl z-[70] overflow-hidden animate-fadeIn">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <span className="text-sm font-semibold text-ink">{tr('components.settings.title')}</span>
            <button onClick={() => setOpen(false)} className="text-ink-muted hover:text-ink">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-2 space-y-1">
            {/* Sound toggle */}
            <button
              onClick={toggleSound}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-hover transition-colors"
            >
              <div className="flex items-center gap-3">
                {soundEnabled ? (
                  <Volume2 className="w-4 h-4 text-brand" />
                ) : (
                  <VolumeX className="w-4 h-4 text-ink-muted" />
                )}
                <span className="text-sm text-ink-body">{tr('components.settings.sound')}</span>
              </div>
              <TogglePill enabled={soundEnabled} />
            </button>

            {/* Vibration toggle */}
            <button
              onClick={toggleVibration}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-hover transition-colors"
            >
              <div className="flex items-center gap-3">
                <Vibrate className={`w-4 h-4 ${vibrationEnabled ? 'text-brand' : 'text-ink-muted'}`} />
                <span className="text-sm text-ink-body">{tr('components.settings.vibration')}</span>
              </div>
              <TogglePill enabled={vibrationEnabled} />
            </button>

            {/* Hardware capture trigger (volume button + Bluetooth remote) */}
            <button
              onClick={toggleHardwareTrigger}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-hover transition-colors"
            >
              <div className="flex items-center gap-3">
                <Aperture className={`w-4 h-4 ${hardwareTriggerEnabled ? 'text-brand' : 'text-ink-muted'}`} />
                <span className="text-sm text-ink-body">{tr('components.settings.hardwareTrigger')}</span>
              </div>
              <TogglePill enabled={hardwareTriggerEnabled} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TogglePill({ enabled }: { enabled: boolean }) {
  return (
    <div className={`w-9 h-5 rounded-full relative transition-colors ${enabled ? 'bg-brand' : 'bg-border-strong'}`}>
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </div>
  );
}

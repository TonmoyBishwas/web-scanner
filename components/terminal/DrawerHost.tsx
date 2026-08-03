'use client';

import { useState, type ReactNode } from 'react';
import { MI } from './MI';
import { SideDrawer } from './SideDrawer';
import { LockedScreen } from './LockedScreen';
import { DocsScreenLocked } from './DocsScreenLocked';
import { ScreenOverlay } from './ScreenOverlay';
import { useSettingsStore } from '@/stores/settings-store';
import { useT } from '@/lib/i18n';

type Screen = 'docs' | 'warehouses' | 'settings' | null;

// Designed settings screen hosting the REAL toggles (sound / vibration /
// hardware trigger) as design-style 52px rows with a switch.
function SettingsScreen({ onBack }: { onBack: () => void }) {
  const tr = useT();
  const {
    soundEnabled, vibrationEnabled, hardwareTriggerEnabled,
    toggleSound, toggleVibration, toggleHardwareTrigger,
  } = useSettingsStore();

  const row = (icon: string, label: string, on: boolean, onToggle: () => void) => (
    <button
      onClick={onToggle}
      className="flex items-center gap-[10px] w-full h-[52px] px-[14px] rounded-[12px] border border-line bg-tile text-ink-inverse text-[14px] font-extrabold"
    >
      <MI name={icon} size={20} />
      {label}
      <span
        className="ms-auto w-[40px] h-[24px] rounded-full px-[3px] flex items-center transition-colors"
        style={{ background: on ? '#13a4ec' : '#2a3a47', justifyContent: on ? 'flex-end' : 'flex-start' }}
      >
        <span className="block w-[18px] h-[18px] rounded-full bg-white" />
      </span>
    </button>
  );

  return (
    <ScreenOverlay title={tr('terminal.settingsTitle')} onBack={onBack}>
      <div className="p-4 flex flex-col gap-[10px]">
        {row('volume_up', tr('components.settings.sound'), soundEnabled, toggleSound)}
        {row('vibration', tr('components.settings.vibration'), vibrationEnabled, toggleVibration)}
        {row('center_focus_strong', tr('components.settings.hardwareTrigger'), hardwareTriggerEnabled, toggleHardwareTrigger)}
      </div>
    </ScreenOverlay>
  );
}

// All translation lives HERE — this component renders as a descendant of the
// page's LanguageContext.Provider, so useT() resolves the session language.
// (The useDrawerHost hook itself runs above that provider and must not
// translate anything.)
function DrawerHostView({
  drawerOpen, screen, onCloseDrawer, onGo, onCloseScreen, footer,
}: {
  drawerOpen: boolean;
  screen: Screen;
  onCloseDrawer: () => void;
  onGo: (s: Screen) => void;
  onCloseScreen: () => void;
  footer?: ReactNode;
}) {
  const tr = useT();
  return (
    <>
      <SideDrawer
        open={drawerOpen}
        onClose={onCloseDrawer}
        items={[
          { id: 'docs', icon: 'description', label: tr('terminal.menuDocs'), onPress: () => onGo('docs') },
          { id: 'warehouses', icon: 'warehouse', label: tr('terminal.menuWarehouses'), onPress: () => onGo('warehouses') },
          { id: 'settings', icon: 'settings', label: tr('terminal.menuSettings'), onPress: () => onGo('settings') },
        ]}
        footer={footer}
      />
      {screen === 'docs' && <DocsScreenLocked onBack={onCloseScreen} />}
      {screen === 'warehouses' && (
        <LockedScreen title={tr('terminal.menuWarehouses')} onBack={onCloseScreen} stubIcon="warehouse" />
      )}
      {screen === 'settings' && <SettingsScreen onBack={onCloseScreen} />}
    </>
  );
}

/**
 * Hosts the side drawer + its nav destinations for the scanner pages:
 * מסמכים (locked, dimmed sample), מחסנים (locked stub), הגדרות (real toggles).
 * Usage: const drawer = useDrawerHost(footer?); render {drawer.node} INSIDE
 * the page's LanguageContext.Provider; open with drawer.open().
 */
export function useDrawerHost(footer?: ReactNode): { open: () => void; node: ReactNode } {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>(null);

  const node = (
    <DrawerHostView
      drawerOpen={drawerOpen}
      screen={screen}
      onCloseDrawer={() => setDrawerOpen(false)}
      onGo={(s) => { setDrawerOpen(false); setScreen(s); }}
      onCloseScreen={() => setScreen(null)}
      footer={footer}
    />
  );

  return { open: () => setDrawerOpen(true), node };
}

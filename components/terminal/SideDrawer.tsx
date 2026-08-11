'use client';

import type { ReactNode } from 'react';
import { MI } from './MI';
import { useT } from '@/lib/i18n';

export interface DrawerNavItem {
  id: string;
  icon: string;
  label: string;
  onPress: () => void;
}

interface SideDrawerProps {
  open: boolean;
  onClose: () => void;
  items: DrawerNavItem[];
  /** Optional slot pinned to the drawer bottom (e.g. session timer) */
  footer?: ReactNode;
}

// Design side drawer: inline-start-anchored 272px panel on #0a0f14 (right in
// RTL), scrim toggle, active "מצב סריקה" chip, "מסכים" section of 52px rows.
export function SideDrawer({ open, onClose, items, footer }: SideDrawerProps) {
  const tr = useT();
  if (!open) return null;

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-[60] bg-black/55" />
      <div className="fixed top-0 bottom-0 start-0 w-[272px] z-[61] bg-header border-e border-line shadow-[-16px_0_44px_rgba(0,0,0,.6)] flex flex-col px-4 py-[18px] safe-top">
        <div className="flex justify-between items-center">
          <button onClick={onClose} className="flex text-ink-inverse ms-auto" aria-label="close">
            <MI name="close" size={22} />
          </button>
        </div>

        <div className="flex flex-col gap-[10px] mt-2">
          {/* Active mode chip — we are always in scan mode */}
          <button
            onClick={onClose}
            className="flex items-center gap-[10px] w-full h-[52px] px-[14px] rounded-[12px] border text-[14px] font-extrabold transition-colors"
            style={{ background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#13a4ec' }}
          >
            <MI name="qr_code_scanner" size={20} />
            {tr('terminal.menuScanMode')}
          </button>
        </div>

        <div className="h-px bg-line my-4" />
        <div className="text-[9px] font-extrabold text-[#cbd5e1] tracking-[2px] mb-[10px]">
          {tr('terminal.menuScreens')}
        </div>
        <div className="flex flex-col gap-[10px]">
          {items.map(item => (
            <button
              key={item.id}
              onClick={item.onPress}
              className="flex items-center gap-[10px] w-full h-[52px] px-[14px] rounded-[12px] border border-line bg-tile text-ink-inverse text-[14px] font-extrabold"
            >
              <MI name={item.icon} size={20} />
              {item.label}
              <MI name="chevron_left" size={18} className="ms-auto text-[#cbd5e1]" />
            </button>
          ))}
        </div>

        {footer && <div className="mt-auto pt-4 safe-bottom">{footer}</div>}
      </div>
    </>
  );
}
